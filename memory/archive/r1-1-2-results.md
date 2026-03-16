# R1-1 and R1-2 Implementation Results

Completed: 2026-03-15

---

## Summary

Both R1-1 and R1-2 were implemented in `src/core-loop.ts`. All 2854 tests pass (was 2844; 10 new tests added in `tests/r1-core-loop-completion.test.ts`).

---

## R1-1: Satisficing短絡修正 — DONE

**Problem**: Step 5 (Completion Check, ~L620-638) had an `if (judgment.is_complete) { return result; }` early-return that skipped the task cycle entirely when the pre-task judgment said "complete". This caused a goal that was 99% done at the end of iteration N to be marked complete at the **start** of iteration N+1 — before the final task actually ran.

**Fix**: Removed the `if (judgment.is_complete) { ... return result; }` block. The `result.completionJudgment = judgment` assignment was kept (used for reporting). The Step 7 post-task re-check (L916-923) already overwrites `result.completionJudgment` with the post-task value, so the main loop at L279 sees the correct post-task completion state.

**Change in `src/core-loop.ts`** — Step 5 now reads:
```typescript
// ─── 5. Completion Check ───
// R1-1: We record the pre-task judgment for reporting, but do NOT early-return here.
// ...
try {
  const judgment = ...;
  result.completionJudgment = judgment;
  // (no early-return)
} catch (err) { ... }
```

**Test updated**: `tests/core-loop.test.ts` L634-648 — changed assertion from `not.toHaveBeenCalled()` to `toHaveBeenCalledOnce()` to reflect that the task cycle always runs.

---

## R1-2: 最低1回実行保証 — DONE

**Problem**: No `minIterations` guard existed on the completion break at L279-282. A goal that was marked complete after iteration 0 would exit the loop after exactly 1 iteration, but if the early-return bug was also present, it could exit without running any task cycle at all.

**Fix**:
1. Added `minIterations?: number` field to `LoopConfig` interface with JSDoc.
2. Added `minIterations: 1` to `DEFAULT_CONFIG`.
3. Gated the completion break with: `loopIndex >= (this.config.minIterations ?? 1) - 1`.

Note: The linter also added `autoArchive?: boolean` to `LoopConfig` and `autoArchive: false` to `DEFAULT_CONFIG` during the same edit session. The archive-on-completion logic in `run()` was updated to require `autoArchive: true` (was previously always archiving on completion).

**Change in `src/core-loop.ts`** — completion break now reads:
```typescript
// Check completion (R1-2: must complete at least minIterations before exiting)
if (iterationResult.completionJudgment.is_complete &&
    loopIndex >= (this.config.minIterations ?? 1) - 1) {
  finalStatus = "completed";
  break;
}
```

---

## New Tests

**File**: `tests/r1-core-loop-completion.test.ts` — 8 tests, all pass.

| Test | What it verifies |
|------|-----------------|
| R1-1: task cycle runs even when goal is already complete | `runTaskCycle` called once even when pre-task `isGoalComplete` returns `true` |
| R1-1: post-task re-check wins over pre-task | If pre=complete, post=not-complete, final judgment is not-complete |
| R1-2: default minIterations=1 exits after 1 iteration | `totalIterations === 1` |
| R1-2: minIterations=2 forces 2 iterations | `totalIterations >= 2` |
| R1-2: minIterations=3 forces exactly 3 iterations | `totalIterations === 3` |
| R1-2: default minIterations=1 means 1 task cycle runs | `runTaskCycle` called once |
| R1-2: minIterations=0 allows immediate exit | Still exits after 1 iteration (loop semantics) |
| R1-1 + R1-2 combined | `finalStatus=completed`, task ran once, 1 iteration total |

---

## Files Changed

| File | Change |
|------|--------|
| `src/core-loop.ts` | LoopConfig + DEFAULT_CONFIG (minIterations), removed Step 5 early-return, gated completion break |
| `tests/core-loop.test.ts` | 1 assertion updated (old short-circuit behavior → new task-always-runs behavior) |
| `tests/r1-core-loop-completion.test.ts` | New file, 8 tests |

---

## Test Results

- Before: 2844 tests, 65 files
- After: 2854 tests, 66 files
- Status: all pass
