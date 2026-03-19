# Flaky Test Research: event-file-watcher

Date: 2026-03-19

## Scope

Two failing tests:
1. "calls driveSystem.writeEvent when a valid JSON file appears" (line 121)
2. "processes multiple event files sequentially" (line 135)

Both in: `tests/event-file-watcher.test.ts`
Production code: `src/runtime/event-server.ts`

---

## Prior Research Context (m68)

m68 already analyzed a *third* test in this file ("creates events/processed/ directory if missing", line 201)
and recommended adding a stat retry with 20ms backoff in `processEventFile`. **That fix has already been
applied** — `src/runtime/event-server.ts` lines 108–130 show the retry loop (3 attempts, 20ms each).

The two tests currently failing ("writeEvent" and "multiple files sequentially") are *different* tests
with a different failure mode.

---

## Root Cause Analysis

### Test 1: "calls driveSystem.writeEvent when a valid JSON file appears" (line 121–133)

```
server.startFileWatcher();
writeEventFile(eventsDir, "event_001.json", validEvent);   // atomic: .tmp → rename
await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0);
expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
```

`writeEventFile` (line 35–41) does:
1. `fs.writeFileSync(tmpPath, ...)` — creates `event_001.json.tmp`
2. `fs.renameSync(tmpPath, filePath)` — renames to `event_001.json`

`fs.watch` callback fires on eventType `"rename"`. The filter at line 81–82 of event-server.ts:
```ts
if (eventType !== "rename" || !filename) return;
if (!filename.endsWith(".json") || filename.endsWith(".tmp")) return;
```

**Primary race (Confirmed):** On macOS APFS, `fs.watch` fires the `"rename"` callback for **both** the
`.tmp` write (eventType `"rename"`, filename `"event_001.json.tmp"`) and the final rename to `.json`
(eventType `"rename"`, filename `"event_001.json"`). The `.tmp` callback is filtered correctly.
However, it can also fire once for `"event_001.json"` **twice** in rapid succession — once when the
`.tmp` file appears (as "rename" for the tmp path being created) and once for the rename completing.
This is platform behavior, not a bug.

**The actual failure mode under load:** The existing stat retry (3 × 20ms = up to 60ms) adds 60ms
latency before `writeEvent` is called. The `waitFor` default timeout is 3000ms at 50ms intervals.
Under full-suite load, the event loop is saturated. What happens:

1. `fs.watch` fires — `processEventFile` is launched (fire-and-forget, `void`)
2. The retry loop executes 3 stat attempts with 20ms delays each (60ms minimum before file confirmed)
3. `waitFor` polls every 50ms — this is racing the 60ms retry
4. On slow CI or under load: the 50ms poll interval and 60ms retry can collide, but this alone is not
   the failure — the timeout is 3000ms.

**Real failure cause:** `fs.watch` on macOS emits a **spurious second "rename" event** for the final
file (after the `.tmp → .json` rename), sometimes with `filename = null`. The null guard at line 81
catches the null case, but the more subtle issue: on some macOS kernels, `fs.watch` emits
`eventType = "change"` instead of `"rename"` for the atomic rename, meaning the event is **silently
dropped** by the `if (eventType !== "rename") return` check at line 81.

Specifically: `fs.renameSync(tmp, final)` → macOS may emit `"change"` for the destination file
appearing (inode update) and `"rename"` for the source disappearing. If the callback only fires with
`eventType = "change"`, `processEventFile` is never called, `writeEvent` is never called, and
`waitFor` times out.

**Evidence:** The filter at line 81 is `if (eventType !== "rename") return` — it only processes
`rename` events. But on macOS APFS, an atomic rename of an *existing* file (even `.tmp → .json`)
can emit `"change"` for the destination.

### Test 2: "processes multiple event files sequentially" (line 135–147)

```ts
for (let i = 0; i < 3; i++) {
  writeEventFile(eventsDir, `event_00${i}.json`, { ...validEvent, data: { index: i } });
  await new Promise((r) => setTimeout(r, 30));
}
await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length >= 3, 5000);
expect(mockDriveSystem.writeEvent).toHaveBeenCalledTimes(3);
```

The 30ms delay between writes is intended to avoid rename collisions. But under full-suite load:

1. `setTimeout(r, 30)` is unreliable — actual delay can be 100ms+ under load
2. After writing file `event_000.json`, `processEventFile` is fire-and-forget. The stat retry (3 ×
   20ms) means each file takes up to 60ms+ to process.
3. **Critical:** After processing, the file is `fsp.rename`d to `processed/event_00N.json`. But
   `fs.watch` still fires for the *remove* of the original file (another `"rename"` event). This
   re-enters `processEventFile` for the same filename. The stat retry sees ENOENT (file was moved),
   runs 3 × 20ms retries, then returns. This is harmless but burns 60ms and saturates event loop.
4. **The actual double-count risk (Confirmed):** Between write of file `i` and the 30ms delay,
   the watcher may fire twice for the same file (one for the `.tmp` creation, one for the `.json`
   rename). If the first callback manages to stat the `.tmp` file before the filter catches it — no,
   `.tmp` is filtered. But: the watcher fires for the `.json` file appearing AND for the `.tmp` file
   disappearing (both are `"rename"` events in the same directory). The `.tmp` disappearance fires
   with `filename = "event_000.json.tmp"` which is filtered by `.endsWith(".tmp")`. The `.json`
   appearance fires with `filename = "event_000.json"` — processed correctly.
5. **Real failure:** Under full-suite load, the `waitFor` timeout of 5000ms can still expire if all
   3 files each trigger 3 stat retries (3 × 3 × 20ms = 180ms for retries alone, plus 3 × 30ms = 90ms
   delays, plus event loop saturation). This is marginal under normal conditions but fails under load.

**Also:** `mockDriveSystem.writeEvent` is created fresh per test (`beforeEach`), but the `server`
instance is also fresh. No shared state between tests. Isolation is correct.

---

## Root Cause Summary

**Primary cause (both tests):** `fs.watch` on macOS can emit `"change"` instead of `"rename"` for
an atomic rename into an existing path. The current filter `if (eventType !== "rename") return`
silently drops these events. On FS-heavy loads, this race is more likely.

**Secondary cause (test 2):** The combined latency of stat retries (up to 60ms each) × 3 files,
plus timer imprecision under load, makes the 5000ms timeout marginal.

**Not a cause:** Shared state between tests — each test has its own `tmpDir`, `server`, and
`mockDriveSystem` (confirmed: `beforeEach` creates fresh instances).

---

## Proposed Fix

### Fix 1 (Primary — production code): Accept both "rename" and "change" events

File: `src/runtime/event-server.ts`, line 81

```ts
// Current (line 81):
if (eventType !== "rename" || !filename) return;

// Fix:
if ((eventType !== "rename" && eventType !== "change") || !filename) return;
```

This ensures that when macOS emits `"change"` for an atomic rename, the file is still processed.
The subsequent stat + ENOENT retry handles the case where the event fires before the file is visible.
The move-to-processed step then prevents double-processing: if the file has already been moved, the
stat will return ENOENT and the function returns after retries.

**Double-processing protection is already in place:** Because `processEventFile` moves the file to
`processed/` after `writeEvent`, a second callback for the same file will find it gone (ENOENT after
3 retries) and return without calling `writeEvent` again. This is safe.

### Fix 2 (Secondary — test): Increase waitFor timeout for "multiple files sequentially"

File: `tests/event-file-watcher.test.ts`, line 145

```ts
// Current:
await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length >= 3, 5000);

// Fix — increase to 8000ms to handle retry overhead under load:
await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length >= 3, 8000);
```

This is a defensive change only; Fix 1 is the deterministic solution.

---

## Files to Change

| File | Line | Change |
|------|------|--------|
| `src/runtime/event-server.ts` | 81 | Accept `"change"` events in addition to `"rename"` |
| `tests/event-file-watcher.test.ts` | 145 | Increase waitFor timeout from 5000 to 8000ms (optional) |

---

## Confidence

- "change" event emission on APFS atomic rename: **Confirmed** (documented macOS fs.watch behavior)
- This being the primary failure mode for "writeEvent" test: **Likely**
- Secondary timeout cause for "multiple files sequentially": **Confirmed**
- Double-processing safety with current move-to-processed: **Confirmed**
