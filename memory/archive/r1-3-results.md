# R1-3 Implementation Results

Implemented 2026-03-15.

## Changes Made

### 1. `src/state-manager.ts` — loadGoal() archive fallback

Modified `loadGoal()` (L89-94) to add a two-path lookup:
- Primary: `goals/<goalId>/goal.json` (active goals, unchanged behavior)
- Fallback: `archive/<goalId>/goal/goal.json` (archived goals)

If the primary path returns null (file not found), the method now checks the archive path before returning null. This is a non-breaking change — all existing callers get transparent fallback.

### 2. `src/core-loop.ts` — autoArchive config (L396-403 + LoopConfig)

- Added `autoArchive?: boolean` field to `LoopConfig` interface with JSDoc explaining default-off rationale
- Added `autoArchive: false` to `DEFAULT_CONFIG`
- Gated the `archiveGoal()` call at L396-403 with `&& this.config.autoArchive`

Before: archive ran unconditionally on every completed goal run.
After: archive only runs when caller explicitly sets `autoArchive: true`.

Rationale: archiving is irreversible (removes active-path directory). Default should be OFF.

### 3. `tests/state-manager.test.ts` — two new tests added

- `"loadGoal falls back to archive after archiveGoal()"` — saves a goal, archives it, verifies loadGoal still returns it via archive fallback
- `"loadGoal returns null for a goal that was never saved nor archived"` — ensures the double-fallback still returns null correctly for nonexistent goals

### 4. `tests/core-loop.test.ts` — one test updated

The test `"calls stateManager.archiveGoal on completion"` was updated to pass `autoArchive: true` to CoreLoop so it still validates the archive-on-completion code path.

## Test Results

- `tests/state-manager.test.ts`: 48 tests passed (was 46, +2 new)
- `tests/core-loop.test.ts`: 119 tests passed (all passing, 1 updated)

## Open Items

None. R1-3 is complete and independent of R1-1/R1-2. The archive path structure `archive/<goalId>/goal/goal.json` was confirmed from archiveGoal() source code before implementing.
