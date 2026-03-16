# R1 Verification Results

**Date:** 2026-03-15
**Verifier:** Claude Sonnet 4.6 (subagent)

---

## Test Results

**All tests pass: 67 test files, 2864 tests (was 2844 before R1 E2E file)**

```
Test Files  67 passed (67)
Tests       2864 passed (2864)
Duration    27.69s
```

The 20 new tests in `tests/e2e/r1-core-loop-executes.test.ts` all pass.

---

## Code Review Findings

### `src/core-loop.ts` — R1-1 and R1-2 changes

**Step 5 early-return removal (R1-1): CORRECT**

The comment at Step 5 (lines 636–650) reads:
> R1-1: We record the pre-task judgment for reporting, but do NOT early-return here. The task cycle always runs within an iteration.

The completion judgment is stored in `result.completionJudgment` but there is no `return result` or `break` after it. Execution falls through directly to Step 6 (stall check) and then Step 7 (task cycle). This is the correct fix.

**minIterations guard (R1-2): CORRECT**

In `run()`, the completion exit condition (lines 293–297) reads:
```ts
if (iterationResult.completionJudgment.is_complete &&
    loopIndex >= (this.config.minIterations ?? 1) - 1) {
  finalStatus = "completed";
  break;
}
```

- `DEFAULT_CONFIG.minIterations = 1` (line 105)
- With `minIterations=1`, the condition becomes `loopIndex >= 0`, which is satisfied from the first iteration (loopIndex=0). This means the loop exits after exactly 1 completed iteration — correct.
- With `minIterations=2`, the condition becomes `loopIndex >= 1`, so the loop cannot exit until after the second iteration — correct.
- With `minIterations=0`, the condition becomes `loopIndex >= -1`, always satisfied — allows immediate exit after first completed iteration, as documented.

**autoArchive default: CORRECT**

`DEFAULT_CONFIG.autoArchive = false` (line 106). The archive block at lines 411–418 is gated on `this.config.autoArchive`. The flag is documented in `LoopConfig` JSDoc. No regression risk.

---

### `src/state-manager.ts` — R1-3 archive fallback

**loadGoal() archive fallback path (R1-3): CORRECT**

```ts
loadGoal(goalId: string): Goal | null {
  // Primary path: active goals
  const filePath = path.join(this.baseDir, "goals", goalId, "goal.json");
  const raw = this.readJsonFile<unknown>(filePath);
  if (raw !== null) return GoalSchema.parse(raw);

  // Fallback: archived goals (archiveGoal() copies goal dir to archive/<goalId>/goal/)
  const archivePath = path.join(this.baseDir, "archive", goalId, "goal", "goal.json");
  const archiveRaw = this.readJsonFile<unknown>(archivePath);
  if (archiveRaw === null) return null;
  return GoalSchema.parse(archiveRaw);
}
```

The `archiveGoal()` method (lines 122–132) copies `goals/<goalId>/` to `archive/<goalId>/goal/` via `fs.cpSync`. The fallback path in `loadGoal()` is `archive/<goalId>/goal/goal.json`, which matches exactly. The path is correct.

---

### `tests/core-loop.test.ts` — Updated assertions

The assertion at the archive-on-completion test (line 2584–2598) checks:
```ts
const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0, autoArchive: true });
expect(archiveSpy).toHaveBeenCalledWith("goal-1");
```

This correctly verifies that `archiveGoal` is only called when `autoArchive: true` is explicitly set. The companion test at line 2621–2633 confirms it is NOT called when `autoArchive` is omitted (defaults to false). Both assertions are semantically correct.

---

## E2E Test File Created

**File:** `tests/e2e/r1-core-loop-executes.test.ts`

### Tests (20 total across 3 describe blocks):

**R1-1 E2E (3 tests):**
- `adapter.execute is reached when goal has dimensions clearly below threshold` — uses `current_value=0.0, threshold=0.8`, verifies `runTaskCycle` was called
- `task cycle runs even with maxIterations=3 and goal remains unsatisfied` — verifies 3 iterations × 3 task cycle calls
- `task cycle runs even when pre-task completion check says complete` — verifies no early-return at Step 5

**R1-2 E2E (3 tests):**
- `default minIterations=1: loop exits after first completed iteration` — `totalIterations=1`
- `minIterations=2 forces at least 2 full iterations` — `totalIterations >= 2`
- `minIterations=3 ensures task cycle runs 3 times` — `totalIterations=3`, `runTaskCycle` called 3 times

**R1-3 E2E (4 tests):**
- `loadGoal() returns the goal after archiving it` — saves, archives, verifies primary path gone, loadGoal still returns data
- `loadGoal() returns null for a goal that was never saved`
- `loadGoal() returns null after deleting a non-archived goal`
- `archived goal data is intact (title, dimensions, status preserved)`

---

## Issues Found

**None.** All three R1 fixes are correctly implemented:
- R1-1: Step 5 no longer returns early; task cycle always runs
- R1-2: `minIterations` guard properly gates the completion exit
- R1-3: `loadGoal()` archive fallback path matches `archiveGoal()` destination

The `autoArchive` default change (false) is a non-breaking improvement that prevents unintended irreversible archiving.
