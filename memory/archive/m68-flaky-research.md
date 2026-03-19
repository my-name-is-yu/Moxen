# M68: Flaky Test Root Cause Analysis

Date: 2026-03-19

---

## Test 1: `tests/event-file-watcher.test.ts`
### Test: "processed files are moved to processed/ > creates events/processed/ directory if missing"

**Lines:** 201–213

```ts
it("creates events/processed/ directory if missing", async () => {
  const eventsDir = path.join(tmpDir, "events");
  server.startFileWatcher();

  expect(fs.existsSync(path.join(eventsDir, "processed"))).toBe(false);

  writeEventFile(eventsDir, "event_make_processed_dir.json", validEvent);

  await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0);
  await waitFor(() => fs.existsSync(path.join(eventsDir, "processed")));

  expect(fs.existsSync(path.join(eventsDir, "processed"))).toBe(true);
});
```

**Relevant production code:** `src/runtime/event-server.ts` lines 75–133

The `fs.watch()` callback fires with `eventType="rename"` when a file is renamed into place. It then calls `processEventFile()` asynchronously via `void this.processEventFile(...).catch(...)`.

Inside `processEventFile()` (line 105–133):
1. `stat` the file (async)
2. `readFile` (async)
3. `JSON.parse` + Zod parse
4. `driveSystem.writeEvent(event)` (async — resolves immediately since mocked)
5. `mkdir(processedDir, { recursive: true })` (async — creates `processed/`)
6. `rename(filePath, dstPath)` (async)

**Root cause — Confirmed**

The `waitFor` on `mockDriveSystem.writeEvent.mock.calls.length > 0` (line 209) resolves **after step 4** but **before step 5** (`mkdir` for `processed/`). This is a classic TOCTOU gap: the `waitFor` condition is satisfied at a point in the async pipeline that does not guarantee the side effect being asserted has occurred.

Because `writeEvent` is mocked as `vi.fn().mockResolvedValue(undefined)`, it resolves synchronously in the microtask queue, so the `await waitFor` for `writeEvent` can complete before the subsequent `await fsp.mkdir(processedDir)` in `processEventFile` has run. The second `waitFor` on the directory existence does poll correctly (lines 210–211), but on fast machines the `expect` on line 212 is evaluated **before** the event loop processes the `processedDir` mkdir promise — particularly if the `waitFor` itself has a race with the final assertion.

Actually, looking more carefully: both `waitFor` calls are awaited in sequence. The *real* failure mode is more subtle: `fs.watch` on macOS can fire the `rename` event **before** the file is fully visible to `fsp.stat`. When that happens, `fsp.stat` throws `ENOENT` at line 109 and `processEventFile` returns early (line 111: `return`). `writeEvent` is **never called**. The `waitFor` at line 209 then times out (3 s), causing an error. This is the primary race condition: the file watcher fires `rename` twice — once for the `.tmp` rename away, and once for the final `json` rename into place — but timing of inode visibility on macOS HFS+/APFS varies.

**Secondary failure mode:** Even if stat succeeds, on heavily loaded CI runners, the 3000 ms `waitFor` default may not be enough when the event loop is saturated by parallel test suite execution.

**Recommended fix (deterministic)**

The issue is that `processEventFile` silently returns on `ENOENT` at stat-time. Add a small retry on `ENOENT` in `processEventFile`:

```ts
// In processEventFile, replace the stat block:
let stat;
let attempts = 0;
while (attempts < 3) {
  try {
    stat = await fsp.stat(filePath);
    break;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && attempts < 2) {
      await new Promise((r) => setTimeout(r, 20));
      attempts++;
    } else {
      return; // truly gone
    }
  }
}
```

This makes the production code robust to the `rename` event firing before inode visibility completes. No test changes needed; the existing `waitFor` pattern then works reliably.

---

## Test 2: `tests/core-loop-reporting.test.ts`
### Test: "CoreLoop > concurrent stop() > stops between iterations"

**Lines:** 664–679

```ts
it("stops between iterations", async () => {
  const { deps, mocks } = createMockDeps(tmpDir);
  await mocks.stateManager.saveGoal(makeGoal());

  const loop = new CoreLoop(deps, {
    maxIterations: 100,
    delayBetweenLoopsMs: 10,
  });

  // Stop after a short delay
  setTimeout(() => loop.stop(), 5);

  const result = await loop.run("goal-1");
  expect(result.finalStatus).toBe("stopped");
  expect(result.totalIterations).toBeGreaterThanOrEqual(1);
});
```

**Relevant production code:** `src/core-loop.ts` lines 92–276

The `run()` loop (line 133) checks `this.stopped` at two points per iteration:
- Line 134: `if (this.stopped) { finalStatus = "stopped"; break; }` — at loop top
- Line 196: `if (this.stopped) { finalStatus = "stopped"; break; }` — at loop bottom, after task cycle

The delay is applied at line 216: `await sleep(this.config.delayBetweenLoopsMs)` (10 ms). The `setTimeout(() => loop.stop(), 5)` fires 5 ms after `loop.run()` is called.

**Root cause — Confirmed**

The timing is fundamentally unreliable. `setTimeout(fn, 5)` in Node.js does not guarantee 5 ms. Under high test suite load (this test only fails in full suite run), the event loop is saturated and timer resolution degrades. Three distinct race conditions:

1. **Timer fires too late:** If the full suite is busy and the 5 ms timer fires after the first iteration and the 10 ms sleep have both already completed, the `stopped` flag is not set before the loop proceeds to iteration 2, 3, etc. The test still passes (`totalIterations >= 1`) but `finalStatus` may be `completed` (the mock `satisficingJudge.isGoalComplete` returns `is_complete: false` by default, so this is unlikely — but `maxIterations: 100` with `delayBetweenLoopsMs: 10` means the loop runs fast, and the first iteration itself takes ~0 ms because all deps are mocked). The first iteration completes near-instantly, the 10 ms sleep begins, and the 5 ms timer should fire during the sleep window — but under load, both timers can resolve in the wrong order.

2. **Timer fires too early:** If the 5 ms fires before `run()` has even entered the loop (very fast call stack), `this.stopped = true` is set but `run()` resets it to `false` at line 94: `this.stopped = false`. This is the most dangerous race — `stop()` is called **before** `run()` resets the flag. Result: loop runs to `maxIterations` and returns `max_iterations` not `stopped`.

   Looking at line 94 in `run()`:
   ```ts
   async run(goalId: string): Promise<LoopResult> {
     const startedAt = new Date().toISOString();
     this.stopped = false;    // <-- RESETS the flag!
   ```
   And the test calls:
   ```ts
   setTimeout(() => loop.stop(), 5);
   const result = await loop.run("goal-1");
   ```
   If the JS engine yields before entering `run()`'s body (async boundary), the timer fires, sets `stopped = true`, then `run()` sets it back to `false`. This is the primary confirmed race.

3. **`result.totalIterations >= 1` guard is loose:** Even if `stopped` is set correctly, if iteration 0 completes before the flag check, `totalIterations` is 1 and the assertion passes. But if the flag is reset (race #2), `finalStatus` is not `"stopped"`, failing that assertion.

**Recommended fix (deterministic)**

Remove the fragile `setTimeout` approach. Instead, use a controlled mechanism: call `stop()` from inside the mock, after the first iteration, using a callback hooked into `taskLifecycle.runTaskCycle`:

```ts
it("stops between iterations", async () => {
  const { deps, mocks } = createMockDeps(tmpDir);
  await mocks.stateManager.saveGoal(makeGoal());

  const loop = new CoreLoop(deps, {
    maxIterations: 100,
    delayBetweenLoopsMs: 0,
  });

  let callCount = 0;
  mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      // Stop the loop after first task cycle completes
      loop.stop();
    }
    return makeTaskCycleResult();
  });

  const result = await loop.run("goal-1");
  expect(result.finalStatus).toBe("stopped");
  expect(result.totalIterations).toBeGreaterThanOrEqual(1);
});
```

This is fully deterministic: `stop()` is always called synchronously during the first task cycle, the `stopped` flag is set before the post-iteration check at line 196, and no timers are involved. Note: `delayBetweenLoopsMs: 0` eliminates the sleep, making the test faster.

Additionally, there is a **production code bug** that should be fixed regardless: `run()` unconditionally resets `this.stopped = false` at line 94. This means any call to `stop()` before `run()` is silently discarded. The fix is to only reset `stopped` if the loop is not already stopped, or to document this contract clearly. Suggested fix in `src/core-loop.ts`:

```ts
async run(goalId: string): Promise<LoopResult> {
  const startedAt = new Date().toISOString();
  // Only reset if not already externally stopped before run() was entered
  if (!this.stopped) {
    this.stopped = false;
  }
  // ... rest of run()
```

Actually simpler — just remove the reset entirely and document that `run()` respects a pre-set `stopped` flag. Or keep the reset but note it as a known limitation. The test fix above avoids the pre-run race entirely.

---

## Test 3: `tests/state-manager.test.ts`
### Test: "StateManager > milestone tracking > evaluatePace > handles 0 elapsed time without divide-by-zero"

**Lines:** 392–406

```ts
it("handles 0 elapsed time without divide-by-zero", () => {
  // created_at = now, target in the future → elapsed_ratio ≈ 0
  const now = new Date();
  const futureDate = new Date(now.getTime() + 100 * 24 * 60 * 60 * 1000).toISOString();
  const milestone = makeMilestone({
    id: "m-zero-elapsed",
    created_at: now.toISOString(),
    target_date: futureDate,
  });

  const snapshot = manager.evaluatePace(milestone, 0.0);
  // Should not throw; pace_ratio = 1 when elapsed_ratio ≈ 0
  expect(snapshot.status).toBe("on_track");
  expect(snapshot.pace_ratio).toBe(1);
});
```

**Relevant production code:** `src/state-manager.ts` lines 365–417

```ts
evaluatePace(milestone: Goal, currentAchievement: number): PaceSnapshot {
  const now = new Date();
  // ...
  const createdAt = new Date(milestone.created_at).getTime();
  // ...
  const elapsed = now.getTime() - createdAt;
  const elapsedRatio = Math.min(elapsed / totalDuration, 1);

  let paceRatio: number;
  if (elapsedRatio === 0) {
    // No time elapsed yet — treat as on_track
    paceRatio = 1;
  } else {
    paceRatio = currentAchievement / elapsedRatio;
  }
```

**Root cause — Confirmed**

The test constructs `now` at the JavaScript level (`const now = new Date()`), then uses `now.toISOString()` as `created_at`. Inside `evaluatePace()`, a **second** `new Date()` is created (line 366). By the time `evaluatePace` runs, wall-clock time has advanced — even by just 1 ms. Therefore `elapsed = now_in_prod.getTime() - createdAt` is always `>= 1` ms, making `elapsedRatio > 0`. The `if (elapsedRatio === 0)` branch (line 400) is **never reached** in practice.

With `currentAchievement = 0.0` and a small but nonzero `elapsedRatio`, `paceRatio = 0.0 / elapsedRatio = 0.0`, so `status = "behind"` — not `"on_track"`. The test asserts `expect(snapshot.pace_ratio).toBe(1)` which fails.

This fails intermittently because on very fast machines or when the test runs alone (no suite overhead), the two `Date.now()` calls can occasionally both resolve to the same millisecond, making `elapsed = 0` and the guard branch fires. Under load (full suite), the gap between the two `new Date()` calls widens, reliably producing `elapsedRatio > 0` and causing the assertion to fail.

The comment `// elapsed_ratio ≈ 0` in the test acknowledges the approximation, but the production guard `if (elapsedRatio === 0)` requires **exactly** zero — an impossible condition when the milestone is constructed outside the function.

**Recommended fix (deterministic)**

Two options:

**Option A (preferred — fix the production guard):** Change the guard in `evaluatePace` from exact-zero to a small epsilon (e.g., less than 1 second elapsed out of a 100-day total is functionally zero):

```ts
// In src/state-manager.ts evaluatePace(), replace:
if (elapsedRatio === 0) {

// With:
if (elapsedRatio < 1 / totalDuration * 1000) {  // less than 1 second elapsed
```

Or more simply, use a threshold-based guard:
```ts
const ONE_SECOND_MS = 1000;
if (elapsed < ONE_SECOND_MS) {
  // Treat sub-second elapsed as zero — avoids divide-by-near-zero and makes
  // the zero-elapsed test deterministic regardless of call timing.
  paceRatio = 1;
}
```

**Option B (test-only fix — inject time):** Add a `nowOverride?: Date` parameter to `evaluatePace` and use it in the test:

```ts
// In production:
evaluatePace(milestone: Goal, currentAchievement: number, now?: Date): PaceSnapshot {
  const resolvedNow = now ?? new Date();
  // ...use resolvedNow throughout
}

// In test:
const snapshot = manager.evaluatePace(milestone, 0.0, now); // pass the same now
```

Option A is preferred because it fixes both the production semantics (sub-second elapsed should not penalize pace) and makes the test pass without any test modification. Option B is more surgical but adds a testing seam to production code.

---

## Summary Table

| # | Test | Root Cause Type | Determinism Issue |
|---|------|-----------------|-------------------|
| 1 | event-file-watcher — processed/ dir created | FS watch race: `rename` event fires before inode is stat-able | Production: add stat retry with 20ms backoff (3 attempts) |
| 2 | core-loop-reporting — stops between iterations | Timer race: `stop()` before `run()` resets `this.stopped = false`; also timer resolution under load | Test: call `loop.stop()` from inside mock; Production: consider not resetting `stopped` in `run()` |
| 3 | state-manager — handles 0 elapsed time | Two `new Date()` calls separated by real wall-clock time; `=== 0` guard never fires | Production: change guard to `elapsed < 1000ms` (1 second threshold) |

---

## Files to Change

- `src/runtime/event-server.ts` — Add stat retry with backoff in `processEventFile()` (lines 108–112)
- `src/core-loop.ts` — Remove or conditionalize `this.stopped = false` reset at line 94
- `src/state-manager.ts` — Change `if (elapsedRatio === 0)` to `if (elapsed < 1000)` at line 400
- `tests/core-loop-reporting.test.ts` — Replace `setTimeout(..., 5)` with mock-based stop trigger (lines 673–676)
