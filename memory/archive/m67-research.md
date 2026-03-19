# Issue #67 Research: `converged_satisficed` not propagated through `judgeTreeCompletion()`

## 1. The Exact Bug (with line numbers)

**File:** `src/drive/satisficing-judge.ts`, line 501-502

```typescript
async judgeTreeCompletion(rootId: string): Promise<CompletionJudgment> {
  return await judgeTreeCompletionFn(rootId, this.stateManager, (goal) => this.isGoalComplete(goal));
}
```

The callback `(goal) => this.isGoalComplete(goal)` only passes `goal` as the first argument. It drops the second argument `convergenceStatuses` entirely. This means every leaf node evaluated inside `judgeTreeCompletionFn` calls `isGoalComplete(goal, undefined)`, so the `convergenceStatuses` check at lines 300-306 of `satisficing-judge.ts` is never executed during tree traversal.

**File:** `src/drive/satisficing-propagation.ts`, line 18-22 and 34-36

```typescript
export async function judgeTreeCompletion(
  rootId: string,
  stateManager: StateManager,
  isGoalComplete: (goal: Goal) => CompletionJudgment   // <-- only takes 1 arg
): Promise<CompletionJudgment> {
  ...
  // Leaf node (no children): delegate to existing isGoalComplete
  if (!goal.children_ids || goal.children_ids.length === 0) {
    return isGoalComplete(goal);   // <-- convergenceStatuses never passed
  }
```

The callback type in `satisficing-propagation.ts` is `(goal: Goal) => CompletionJudgment` — a single-argument signature. It has no slot for `convergenceStatuses`.

## 2. How `convergenceStatuses` Is Generated

`convergenceStatuses` is a `Map<string, SatisficingStatus>` built by the caller. The data originates in `judgeConvergence()` (satisficing-judge.ts, line 100-123):

1. Caller invokes `judge.judgeConvergence(key, gap, threshold)` for each `goalId:dimensionName` pair.
2. `judgeConvergence()` records the gap in the in-memory ring buffer (`this.gapHistory`) and returns a `ConvergenceJudgment` with a `.status` field.
3. The caller is responsible for collecting these `.status` values into a `Map<string, SatisficingStatus>` and passing it to `isGoalComplete(goal, convergenceStatuses)`.
4. Keys follow the format `${goalId}:${dimensionName}` (see satisficing-judge.ts line 301).

The ring buffer lives on the `SatisficingJudge` instance — it is NOT persisted to state. This means convergence data is ephemeral per-session, per-instance.

The `gapHistory` is populated by whoever runs the observation-and-gap loop (typically `CoreLoop` or `TreeLoopOrchestrator`). Those callers would need to pass the accumulated statuses when calling `judgeTreeCompletion()`.

## 3. Minimal Fix

### What needs to change

**Step A — Update the callback signature in `satisficing-propagation.ts` (L21)**

Change:
```typescript
isGoalComplete: (goal: Goal) => CompletionJudgment
```
To:
```typescript
isGoalComplete: (goal: Goal, convergenceStatuses?: Map<string, SatisficingStatus>) => CompletionJudgment
```

Also add the import for `SatisficingStatus` at the top of this file:
```typescript
import type { CompletionJudgment, SatisficingStatus } from "../types/satisficing.js";
```

**Step B — Thread `convergenceStatuses` through `judgeTreeCompletion` in `satisficing-propagation.ts`**

Add the parameter to the exported function signature and pass it down recursively:

```typescript
export async function judgeTreeCompletion(
  rootId: string,
  stateManager: StateManager,
  isGoalComplete: (goal: Goal, convergenceStatuses?: Map<string, SatisficingStatus>) => CompletionJudgment,
  convergenceStatuses?: Map<string, SatisficingStatus>   // <-- ADD
): Promise<CompletionJudgment> {
  ...
  // Leaf node:
  return isGoalComplete(goal, convergenceStatuses);      // <-- PASS
  ...
  // Recursive call:
  const childJudgment = await judgeTreeCompletion(childId, stateManager, isGoalComplete, convergenceStatuses);
}
```

**Step C — Update the wrapper in `satisficing-judge.ts` (L501-502)**

```typescript
async judgeTreeCompletion(
  rootId: string,
  convergenceStatuses?: Map<string, SatisficingStatus>
): Promise<CompletionJudgment> {
  return await judgeTreeCompletionFn(
    rootId,
    this.stateManager,
    (goal, cs) => this.isGoalComplete(goal, cs),
    convergenceStatuses
  );
}
```

Import for `SatisficingStatus` is already present in `satisficing-judge.ts` (line 11).

### Files changed

| File | Change |
|------|--------|
| `src/drive/satisficing-propagation.ts` | Add `SatisficingStatus` import; add `convergenceStatuses?` param to `judgeTreeCompletion`; pass it to leaf call and recursive call |
| `src/drive/satisficing-judge.ts` | Add `convergenceStatuses?` param to `judgeTreeCompletion` method; update callback to forward `cs`; pass `convergenceStatuses` to `judgeTreeCompletionFn` |

Total change: ~10 lines. No type changes needed in `types/satisficing.ts`.

## 4. Edge Cases to Watch For

**4.1 Callers of `judgeTreeCompletion` that do not supply `convergenceStatuses`**
The parameter is optional (`?`), so all existing callers continue to work unchanged — `isGoalComplete` receives `undefined` and falls back to the existing `isSatisfiedRaw` path. No behavioral regression.

**4.2 Recursive child traversal**
The same `convergenceStatuses` map must be passed unchanged to every recursive call. Keys encode `goalId:dimensionName`, so child goals have their own distinct keys — no collision risk. The map is read-only during traversal.

**4.3 Ring buffer is per-instance and ephemeral**
`gapHistory` lives on the `SatisficingJudge` instance. If `judgeTreeCompletion` is called from a different instance than the one that ran `judgeConvergence`, the map passed in must be externally pre-built by the caller. This is the caller's responsibility, not the fix's.

**4.4 Non-leaf nodes**
The fix only affects leaf nodes (line 36: `return isGoalComplete(goal, convergenceStatuses)`). Non-leaf nodes aggregate their children's `CompletionJudgment` results — this aggregation logic (lines 59-78) is not affected.

**4.5 `low_confidence_dimensions` promotion**
When `convergenceStatuses` marks a dimension as `converged_satisficed`, `isGoalComplete` promotes `confidence_tier` from `"low"` to `"medium"` (satisficing-judge.ts line 304). This prevents the dimension from appearing in `low_confidence_dimensions`, which would otherwise block `is_complete`. This behavior is correct and is preserved by the fix.

## 5. Which Test Files Need New Test Cases

### `tests/satisficing-judge-convergence.test.ts`
Add a new `describe` block: **`judgeTreeCompletion respects convergenceStatuses`**

Required test cases:
- Leaf node with one `converged_satisficed` dimension in the map → `is_complete: true` (proves the bug is fixed)
- Leaf node with `converged_satisficed` status but no map supplied → `is_complete: false` (regression guard)
- Multi-level tree: child leaf has `converged_satisficed` dimension; verify root returns `is_complete: true` (validates recursive threading)
- Tree with mixed children: one child satisficed normally, one via `converged_satisficed` → root is complete

### `tests/satisficing-judge-threshold-propagation.test.ts`
No new test cases required — this file covers `detectThresholdAdjustmentNeeded` and `propagateSubgoalCompletion`, which are unaffected by this fix.

### `tests/satisficing-judge-propagation-phase2.test.ts`
No new test cases required — this file covers `propagateSubgoalCompletion` Phase 2 mapping, unaffected.

### Optional: new dedicated test file
Consider `tests/satisficing-judge-tree-completion.test.ts` if the new test block grows large (> ~100 lines). Use `makeGoal` fixture + `stateManager.saveGoal` to build multi-level trees, following the pattern already established in the existing test files.
