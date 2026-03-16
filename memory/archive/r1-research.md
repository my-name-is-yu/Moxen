# Phase R1 Implementation Research

Researched 2026-03-15. Covers three R1 sub-tasks.

---

## R1-1: Satisficing短絡修正 (Completion Check after Task Cycle)

### Current Flow in `runOneIteration()` (src/core-loop.ts)

Step 5 — Completion Check: **L620–638**
```
// ─── 5. Completion Check ───
judgment = satisficingJudge.isGoalComplete(goal)  // or judgeTreeCompletion
if (judgment.is_complete) → early return (no task executed)
```

Step 7 — Task Cycle: **L838–930**
- L896–903: `taskLifecycle.runTaskCycle(...)` → `taskResult`
- L916–923: "Re-check completion after task execution" — loads `updatedGoal`, runs
  `isGoalComplete` / `judgeTreeCompletion`, writes to `result.completionJudgment`
  **but does NOT early-return on is_complete = true**

Step 8 — Report: **L953–957**: `tryGenerateReport` then `return result`

### The Bug

At L620–638 (Step 5), if ALL dimensions are already satisfied *before* any task runs, the loop
short-circuits and returns without running the task cycle. This means a goal that was 99% done on
the previous iteration will be marked complete at the start of the *next* iteration — before the
remaining work (final task) has actually run.

The re-check at L916–923 (inside Step 7) already runs completion *after* the task, but it does not
`return result` early; it just overwrites `result.completionJudgment`. The main loop at L279
checks `iterationResult.completionJudgment.is_complete` to decide whether to break.

### What Needs to Change

**Option A (minimal, recommended):** Move the Step 5 early-return guard to *after* Step 7.
Concretely:
1. Remove the `if (judgment.is_complete) { return result; }` guard at L627–632.
2. Keep the `result.completionJudgment = judgment` assignment at L625 (used for reporting).
3. After Step 7 post-task re-check (L916–923), add an early return when `postTaskJudgment.is_complete`.

This ensures at least one task cycle runs per iteration even when Step 5 says "complete."

**2-tier (strong/weak) note:** `SatisficingJudge.isGoalComplete()` currently uses a single
completion criterion: `blockingDimensions.length === 0 && lowConfidenceDimensions.length === 0`
(L210–211). There is NO weak/strong split in the current code. If R1 requires a 2-tier approach
(e.g., "weak complete" = no blocking but low-confidence dims exist → still run one verification
task, "strong complete" = no blocking AND no low-confidence → truly done), that would require:
- Adding a `is_weakly_complete` or `needs_one_more_task` field to `CompletionJudgment`
  (src/types/satisficing.ts)
- Changing the Step 5 early-return to only fire on strong completion

**Confidence: Confirmed** — flow clearly visible at the cited lines.

### Interaction Risks
- The `run()` loop at L279 uses `iterationResult.completionJudgment.is_complete` to break.
  If Step 5 is removed as an early-return but `result.completionJudgment` is still set at L625,
  the loop will not prematurely terminate — it will just run the task cycle first.
- The early return at L627–632 also calls `tryGenerateReport` before returning. That call must be
  preserved if moving the return point: the report should be generated at Step 8 instead.

---

## R1-2: 最低1回実行保証 (minIterations)

### LoopConfig Definition: **L75–93** (src/core-loop.ts)

```typescript
export interface LoopConfig {
  maxIterations?: number;
  maxConsecutiveErrors?: number;
  delayBetweenLoopsMs?: number;
  adapterType?: string;
  treeMode?: boolean;
  multiGoalMode?: boolean;
  goalIds?: string[];
}

const DEFAULT_CONFIG: Required<LoopConfig> = {
  maxIterations: 100,
  maxConsecutiveErrors: 3,
  delayBetweenLoopsMs: 1000,
  adapterType: "claude_api",
  treeMode: false,
  multiGoalMode: false,
  goalIds: [],
};
```

`minIterations` does NOT exist yet. **Confirmed.**

### run() Loop Entry: **L267–352**

```typescript
for (let loopIndex = 0; loopIndex < this.config.maxIterations; loopIndex++) {
  if (this.stopped) { finalStatus = "stopped"; break; }
  // ... run iteration
  if (iterationResult.completionJudgment.is_complete) {
    finalStatus = "completed";
    break;      // ← this is the gate to protect
  }
  // error/approval/escalation break checks
}
```

The completion break is at **L279–282**. The `this.stopped` check is at **L268–271**.

### What Needs to Change

1. Add `minIterations?: number` to `LoopConfig` (L75).
2. Add `minIterations: 1` to `DEFAULT_CONFIG` (L85).
3. In the `run()` loop, gate the completion break (L279–282) so it only fires when
   `loopIndex >= this.config.minIterations - 1`:
   ```typescript
   if (iterationResult.completionJudgment.is_complete &&
       loopIndex >= (this.config.minIterations ?? 1) - 1) {
     finalStatus = "completed";
     break;
   }
   ```
   Default of 1 means: at least one iteration must complete before the loop can exit on
   completion. This is the minimal safe change.

**Interaction with R1-1:** If the Step 5 early-return is removed (R1-1), then R1-2's guard on
the L279 break is the only remaining completion gate. The two changes are complementary and must
both be applied.

**Risk:** Setting `minIterations > 1` means a goal that is already complete at observation will
still run N task cycles. This is intentional but should be documented in LoopConfig.

**Confidence: Confirmed** — field does not exist, loop structure clear.

---

## R1-3: アーカイブフォールバック (Archive Fallback in loadGoal)

### Auto-archive in CoreLoop: **L396–403** (src/core-loop.ts)

```typescript
// Archive goal state on completion
if (finalStatus === "completed") {
  try {
    this.deps.stateManager.archiveGoal(goalId);
  } catch {
    // non-fatal
  }
}
```

Called from `run()` after the main loop exits with `finalStatus === "completed"`.

### loadGoal in StateManager: **L89–94** (src/state-manager.ts)

```typescript
loadGoal(goalId: string): Goal | null {
  const filePath = path.join(this.baseDir, "goals", goalId, "goal.json");
  const raw = this.readJsonFile<unknown>(filePath);
  if (raw === null) return null;
  return GoalSchema.parse(raw);
}
```

Only looks at `goals/<goalId>/goal.json`. After `archiveGoal()` runs:
- Source dir `goals/<goalId>/` is **removed** (L126: `fs.rmSync(goalDir, { recursive: true, force: true })`)
- Goal is at `archive/<goalId>/goal/goal.json`

So any post-completion `loadGoal(goalId)` call returns `null`. This affects:
- `core-loop.ts` L361: `loadGoal(goalId)` for curiosity engine (after loop exits)
- `core-loop.ts` L934: `loadGoal(goalId)` for curiosity loop count (after task cycle)
- Any CLI commands that load a goal by ID after it completes

### What Needs to Change

Add a fallback path to `loadGoal()` in `src/state-manager.ts`:

```typescript
loadGoal(goalId: string): Goal | null {
  // Primary path: active goals
  const filePath = path.join(this.baseDir, "goals", goalId, "goal.json");
  const raw = this.readJsonFile<unknown>(filePath);
  if (raw !== null) return GoalSchema.parse(raw);

  // Fallback: archived goals
  const archivePath = path.join(this.baseDir, "archive", goalId, "goal", "goal.json");
  const archiveRaw = this.readJsonFile<unknown>(archivePath);
  if (archiveRaw === null) return null;
  return GoalSchema.parse(archiveRaw);
}
```

This is a non-breaking change: all existing callers get transparent fallback to archive.

### Archive Path Structure: **Confirmed**
From `archiveGoal()` L124: `archiveGoalDir = path.join(archiveBase, "goal")` and L125:
`fs.cpSync(goalDir, archiveGoalDir, ...)` — so `goal.json` ends up at
`archive/<goalId>/goal/goal.json`.

**Bug #6 from m3-bug-analysis.md** also notes: `loadGoal/loadGapHistory/loadObservationLog`
have no fallback to `archive/<goalId>/goal/` after archiveGoal(). The same fallback pattern
should be considered for `loadGapHistory` and `loadObservationLog` (medium priority, can be
separate sub-task).

**Confidence: Confirmed** — archive path unambiguous from archiveGoal() source.

### Interaction Risks
- If `loadGoal` returns an archived goal with `status: "completed"`, callers that check
  `goal.status !== "active"` may behave differently. Worth checking `run()` L243 — it rejects
  non-active/waiting goals. This is correct: you should not re-run a completed goal.
- `saveGoal()` still writes to `goals/<goalId>/goal.json`. A caller that loads from archive and
  then saves would re-create the active-path file. This is unlikely in current code but worth
  noting.

---

## Cross-Cutting Risks Between R1-1, R1-2, R1-3

1. **R1-1 + R1-2 must be applied together.** If Step 5 early-return is removed but `minIterations`
   guard is not added to the L279 completion break, then a pre-satisfied goal will run the task
   cycle but still short-circuit on `is_complete` at L279 without actually completing the task.

2. **R1-3 is independent** of R1-1/R1-2. It touches only `src/state-manager.ts`.

3. **Test impact:**
   - R1-1: Tests that assert `completionJudgment.is_complete = true` without running a task
     cycle will break (expected — they were testing the short-circuit behavior).
   - R1-2: Tests that pass `minIterations: 1` (the new default) will behave identically to
     current code (default maxIterations with no early-exit guard). Tests that explicitly set
     `minIterations: 0` can restore the old behavior.
   - R1-3: Tests for `loadGoal` should add a case: archive a goal, then verify loadGoal still
     returns it.

---

## Files to Modify

| Task | File | Lines |
|------|------|-------|
| R1-1 | `src/core-loop.ts` | L620–638 (remove early-return), L916–923 (add early-return with report) |
| R1-2 | `src/core-loop.ts` | L75–93 (LoopConfig + DEFAULT_CONFIG), L279–282 (minIterations guard) |
| R1-3 | `src/state-manager.ts` | L89–94 (loadGoal fallback) |

No type changes required for R1-3. R1-2 requires LoopConfig type change (same file).
R1-1 may require `CompletionJudgment` type change in `src/types/satisficing.ts` only if the
2-tier approach is adopted (not needed for the minimal fix).
