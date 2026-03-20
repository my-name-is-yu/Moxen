# LLM Fault Tolerance Research

**Date**: 2026-03-20
**Scope**: Trust mechanics, LLM call points, validation guards, state mutation, gap calculation cascade risks

---

## 1. Trust Change Mechanics

**Source**: `src/traits/trust-manager.ts`, `src/types/trust.ts`

### Constants (src/types/trust.ts:44,50,53)
- `HIGH_TRUST_THRESHOLD = 20`
- `TRUST_SUCCESS_DELTA = +3`
- `TRUST_FAILURE_DELTA = -10`
- Range: `[-100, +100]`, clamped via `clamp()` at every mutation point

### Mutation points
- `recordSuccess(domain)` — L100: adds +3, clamps, persists immediately to `trust/trust-store.json`
- `recordFailure(domain)` — L116: adds -10, clamps, persists immediately
- `setOverride(domain, balance, reason)` — L179: sets to arbitrary value (clamped), logs to `override_log`
- Plugin trust: `recordPluginSuccess` / `recordPluginFailure` — same deltas applied to `PluginState.trust_score` via `PluginLoader`

### Who calls trust updates
Only **one** caller in the codebase:
- `src/execution/task-verifier.ts:281` — `recordSuccess(task.task_category)` on verdict `pass`
- `src/execution/task-verifier.ts:381` — `recordFailure(task.task_category)` on verdict `fail` or wrong-direction `partial`

**Fault tolerance gap**: Trust is updated based on the L2 LLM reviewer verdict (`completion_judger`). If the LLM reviewer gives a wrong verdict (e.g., hallucinated `pass` when task actually failed), trust increases incorrectly. There is no independent check on the verdict before trust mutation.

### Action quadrant (trust + confidence → autonomy)
- `trust >= 20 AND confidence >= 0.50` → `autonomous` (no approval required for reversible actions)
- All others → `execute_with_confirm` or `observe_and_propose`
- Irreversible/unknown reversibility → always requires approval regardless of trust

---

## 2. LLM Call Points

All calls go through `ILLMClient.sendMessage()` → `parseJSON()`. There are ~30+ call sites. High-impact ones:

### A. Task Verification — L2 LLM Reviewer
**File**: `src/execution/task-verifier.ts` L577–662 (`completion_judger` function)

- **Input**: task description, success criteria, executor output (first 2000 chars), session context
- **Expected output**: `{"verdict": "pass"|"partial"|"fail", "reasoning": "...", "criteria_met": N, "criteria_total": N}`
- **Failure handling**: `withRetry` (exponential backoff, configurable retries) + `withTimeout`. On all retries exhausted: returns `{passed: false, partial: false, confidence: 0.0}` — **safe default (fail-closed)**
- **Parse failure**: returns `{passed: false, confidence: 0.3}` — safe default
- **Critical risk**: verdict directly drives `recordSuccess`/`recordFailure` (trust mutation) and `dimension_updates` written to `goals/<id>/goal.json`
- **Note**: Uses `JSON.parse` + manual `parsed.verdict ?? "fail"` fallback, NOT `llmClient.parseJSON` + Zod schema — no schema validation at L613–653

### B. LLM Observation
**File**: `src/observation/observation-llm.ts` L79–191

- **Input**: goal description, dimension label, threshold (JSON), workspace context (git diff or contextProvider), previous score
- **Expected output**: `{"score": 0.0–1.0, "reason": "..."}` validated by `LLMObservationResponseSchema`
- **Failure handling**: exception propagates up to `observe()` in `observation-engine.ts:312`, caught → logs warn → **falls back to `self_report` (existing stored value)**. Safe fallback.
- **Scale translation risk**: L157–164 — if `threshold.type == "min"` or `"max"` and `threshold.value > 1`, `extractedValue = parsed.score * threshold.value`. If threshold parsing fails (catch at L164), uses raw 0–1 score unchanged — could write under-scaled values to state.
- **Context gap**: if neither `contextProvider` nor git-diff returns data, prompt contains the warning text `"Score MUST be 0.0"` — LLM may ignore this instruction

### C. Task Generation
**File**: `src/execution/task-generation.ts` L107–186

- **Input**: goal, dimensions, strategy, repo context, existing tasks
- **Expected output**: `LLMGeneratedTaskSchema` (Zod) — task specification
- **Failure handling**: exception propagates up; no local try/catch in generation function. Failure bubbles to `TaskLifecycle` caller.
- **Risk**: generated task includes `task_category`, `reversibility`, `scope_boundary` — errors here affect trust routing and approval gating

### D. Goal Decomposition / Negotiation
**Files**: `src/goal/negotiator-steps.ts`, `src/goal/goal-negotiator.ts`, `src/goal/goal-decomposer.ts`

- Multiple calls with Zod-validated schemas (`DimensionDecompositionSchema`, `FeasibilityResultSchema`, `CapabilityCheckLogSchema`)
- No retry/timeout wrappers observed — exceptions propagate to caller

### E. Strategy Generation
**File**: `src/strategy/strategy-manager-base.ts` L63

- **Input**: goal context
- **Expected output**: array of strategy objects, parsed by `StrategySchema`
- **Risk**: if strategies array is empty or malformed, `portfolio` could have no active strategy

### F. EthicsGate
**File**: `src/traits/ethics-gate.ts` L578, L636

- **Input**: proposed action
- **Expected output**: `EthicsVerdictSchema` (Zod)
- **Failure handling**: not visible in grep — if LLM call throws, ethics check fails open or closed (needs investigation)

### G. RevertTask
**File**: `src/execution/task-verifier.ts` L696

- **Input**: task description + scope
- **Expected output**: `{"success": boolean, "reason": "..."}`
- **Failure handling**: catch at L714 returns `false` — fail-closed (assume revert failed = safe)

### H. Memory / Knowledge calls (non-critical path)
- `src/knowledge/memory-distill.ts`, `memory-compression.ts`, `learning-pipeline.ts`, `knowledge-manager.ts`, `knowledge-transfer.ts` — LLM used for pattern extraction, lesson distillation, enrichment. Failures here are advisory only; not on execution critical path.

---

## 3. Existing Validation / Guards

### JSON + Zod pipeline (shared for all LLM responses)
**File**: `src/llm/base-llm-client.ts` L38–56

- `extractJSON()` strips markdown code fences (L14–24)
- `schema.safeParse()` used — on failure throws `LLMError` with details
- **All `parseJSON()` callers**: fail with `LLMError` on bad schema — upstream must catch

### Notable schema coverage
- `LLMObservationResponseSchema` — covers score + reason (`score: z.number().min(0).max(1)`)
- `LLMGeneratedTaskSchema` — covers full task structure
- `StrategyArraySchema` — covers strategy list
- `EthicsVerdictSchema`, `VerificationResultSchema`, `DimensionDecompositionSchema`, etc.

### NOT schema-validated
- L2 completion_judger result (`task-verifier.ts` L641–653): uses `JSON.parse` + manual field access with `?? "fail"` fallback. No Zod schema.
- `attemptRevert` response — uses `llmClient.parseJSON` with `z.object({success: z.boolean()})` — covered

### Observation cross-validation
**File**: `src/observation/observation-engine.ts` L86–113

- When `crossValidationEnabled` and DataSource is used, LLM is run in `dryRun` mode to compare
- Divergence > 20% threshold → logs warning, **mechanical value always wins**
- LLM result silently discarded on cross-validation failure

### Dimension name normalization
- `normalizeDimensionName()` strips `_2`, `_3`, `_N` suffixes from LLM-generated dimension names (L169)

---

## 4. State Mutation Points

### High-risk: written by LLM output directly
1. **`goals/<id>/goal.json`** — `dimension.current_value` written by `task-verifier.ts:L316, L348, L737` based on `dimension_updates` from L2 LLM verdict. If verdict is wrong, observation state is corrupted.
2. **`trust/trust-store.json`** — written by `recordSuccess`/`recordFailure` based on L2 verdict. Asymmetric delta (-10 vs +3) limits upward drift but a false `pass` verdict silently increases trust.
3. **`tasks/<goal>/<id>.json`** — task status (`completed`, `failed`) set by `handleVerdict`
4. **`sessions/<id>.json`** — session state written after each adapter execution

### Observation state write
- `applyObservation()` → `StateManager.appendObservation()` — writes per-observation entries.  Fallback path (self_report) re-uses existing value — safe.

### Persistence pattern
- `writeRaw()` is atomic (file-based via StateManager).  Partial writes if process crashes are possible (no transaction semantics visible).
- Goals archived to `~/.motiva/archive/<goalId>/` by CoreLoop on completion — irreversible by default.

---

## 5. Gap Calculation and Cascade Risk

**File**: `src/drive/gap-calculator.ts`

### How gap uses observation output
1. `computeRawGap(currentValue, threshold)` — pure math on `dimension.current_value`
2. `normalizeGap(rawGap, threshold, currentValue)` — normalizes to [0,1]
3. `applyConfidenceWeight(normalizedGap, confidence, uncertaintyWeight, ...)` — inflates gap when confidence is low

**Cascade risk**: gap-calculator takes `dimension.current_value` directly from goal state. If LLM observation writes a wrong score (e.g., 0.9 when actual is 0.1), gap = 0.1 → system thinks goal is nearly achieved → stops generating tasks. This is a **silent false-completion risk**.

### Confidence weighting is a partial mitigation
- LLM observation sets confidence at `0.70` (fixed, `observation-llm.ts:L182`)
- Low-confidence scores inflate gap by `(1 + 0.30 * uncertaintyWeight)` — e.g., at weight=1.0, gap is 1.3x normal
- This means an LLM over-score (e.g., 0.8 when true is 0.5) has its gap partially inflated back → not fully mitigated

### Scale mismatch vulnerability
- `observation-llm.ts:L157–164`: LLM returns 0–1 score; for `min` or `max` thresholds with `value > 1`, score is scaled by `threshold.value`
- If threshold.value is e.g. 100 (e.g. "test count >= 100"), LLM score of 0.5 → `extractedValue = 50`
- Gap-calculator then computes `max(0, 100 - 50) = 50` (correct)
- **But**: if threshold parsing fails at L164, raw 0.5 is stored → gap-calculator computes `max(0, 100 - 0.5) = 99.5` → always max gap. Over-conservative but not silently wrong.

---

## Summary: Key Fault Tolerance Gaps

| # | Location | Risk | Severity |
|---|----------|------|----------|
| 1 | `task-verifier.ts` L641 | L2 verdict not Zod-validated; manual JSON parse with `?? "fail"` | Medium — defaults to fail-closed |
| 2 | `task-verifier.ts` L281/381 | Trust updated immediately from LLM verdict with no secondary check | High — false `pass` inflates trust silently |
| 3 | `task-verifier.ts` L316/348 | `dimension.current_value` overwritten from LLM-generated `dimension_updates` without range check | High — corrupts observation state |
| 4 | `observation-llm.ts` L97–107 | No `contextProvider` + git diff absent → LLM receives no evidence → must score 0.0 but may not | Medium — prompt contains fallback rule but LLM may disobey |
| 5 | `task-generation.ts` | No local retry/timeout wrapper on LLM call | Medium — unhandled LLM errors bubble up |
| 6 | `ethics-gate.ts` | Failure behavior on LLM error unclear (not investigated) | Uncertain |
| 7 | Gap cascade | False LLM observation score can cause false satisficing (system thinks goal done) | High — silent |

---

## Files Referenced

- `src/traits/trust-manager.ts` — full trust mechanics
- `src/types/trust.ts:44,50,53` — constants
- `src/execution/task-verifier.ts` — L281, L316, L381, L450–472 (`withRetry`), L577–662 (`completion_judger`), L696 (`attemptRevert`)
- `src/observation/observation-llm.ts` — L79–191 (full LLM observation function)
- `src/observation/observation-engine.ts` — L86–113 (cross-validation), L256–318 (observe loop with fallback)
- `src/drive/gap-calculator.ts` — L1–200 (full pipeline)
- `src/llm/base-llm-client.ts` — L38–56 (parseJSON + safeParse)
- `src/execution/task-generation.ts` — L133, L261 (LLM calls)
- `src/goal/negotiator-steps.ts`, `src/goal/goal-negotiator.ts` — dimension decomposition + feasibility LLM calls
- `src/strategy/strategy-manager-base.ts` — L63 (strategy generation LLM call)
- `src/traits/ethics-gate.ts` — L578, L636 (ethics check LLM calls)
