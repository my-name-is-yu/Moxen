# Stage 3 API Summary — Manual Test Reference

Generated from source reading of all Stage 3 modules and their test files.

---

## 0. Prerequisite: StateManager

`StateManager` is a required dependency for all Stage 3 modules.

```ts
import { StateManager } from "./src/state-manager.js";

// baseDir is optional — defaults to ~/.motiva/
// For manual tests always pass a temp dir to avoid polluting ~/.motiva/
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-manual-"));
const stateManager = new StateManager(tmpDir);

// Cleanup after test:
// fs.rmSync(tmpDir, { recursive: true, force: true });
```

**Source:** `src/state-manager.ts` line 28: `constructor(baseDir?: string)`

---

## 1. LLMClient

**Source:** `src/llm-client.ts`

### Constructor

```ts
import { LLMClient } from "./src/llm-client.js";

// Option A: pass key directly
const client = new LLMClient("sk-ant-...");

// Option B: rely on env var ANTHROPIC_API_KEY
process.env["ANTHROPIC_API_KEY"] = "sk-ant-...";
const client = new LLMClient();

// Throws if neither is provided:
// Error: "LLMClient: no API key provided..."
```

**Parameters:** `apiKey?: string` (optional; falls back to `process.env["ANTHROPIC_API_KEY"]`)

### Key Public Methods

```ts
// Send a message — retries up to 3x with exponential backoff (1s, 2s, 4s)
const response: LLMResponse = await client.sendMessage(
  [{ role: "user", content: "Hello" }],       // LLMMessage[]
  {                                            // LLMRequestOptions — all optional
    model: "claude-sonnet-4-20250514",         // default: "claude-sonnet-4-20250514"
    max_tokens: 4096,                          // default: 4096
    temperature: 0,                            // default: 0
    system: "You are a helpful assistant.",    // optional system prompt
  }
);
// response: { content: string, usage: { input_tokens, output_tokens }, stop_reason: string }

// Parse JSON from LLM response text (handles ```json ... ``` markdown blocks)
import { z } from "zod";
const MySchema = z.object({ name: z.string() });
const parsed = client.parseJSON(response.content, MySchema);
// Throws on parse failure or Zod validation failure
```

### MockLLMClient (for tests — exported from same file)

```ts
import { MockLLMClient } from "./src/llm-client.js";

const mock = new MockLLMClient(["first response", "second response"]);
// responses: string[]  — returned in order, one per sendMessage() call
// Throws if responses are exhausted

mock.callCount;  // number — tracks total sendMessage() calls
```

The `MockLLMClient` implements `ILLMClient`. Both `LLMClient` and `MockLLMClient` implement the same `parseJSON` logic.

### ILLMClient interface (for custom mocks)

```ts
// Any object satisfying this interface can be injected:
interface ILLMClient {
  sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
```

**Inline mock pattern used in tests:**
```ts
function createMockLLMClient(responses: string[]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(_messages, _options) {
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const jsonBlock = content.match(/```json\s*([\s\S]*?)```/);
      const genericBlock = content.match(/```\s*([\s\S]*?)```/);
      const jsonText = jsonBlock ? jsonBlock[1]!.trim()
        : genericBlock ? genericBlock[1]!.trim()
        : content.trim();
      return schema.parse(JSON.parse(jsonText));
    },
  };
}
```

---

## 2. EthicsGate

**Source:** `src/ethics-gate.ts`

### Constructor

```ts
import { EthicsGate } from "./src/ethics-gate.js";

const gate = new EthicsGate(
  stateManager,   // StateManager — required
  llmClient       // ILLMClient — required
);
```

### Key Public Methods

```ts
// Evaluate a goal/subgoal/task for ethical concerns
// subjectType: "goal" | "subgoal" | "task"
const verdict: EthicsVerdict = await gate.check(
  "goal",                        // EthicsSubjectType
  "goal-uuid-here",              // subjectId: string
  "Improve software quality",   // description: string
  "Parent context (optional)"   // context?: string — optional
);
// Returns: { verdict: "pass"|"flag"|"reject", category: string,
//            reasoning: string, risks: string[], confidence: number }
// Auto-overrides: if verdict="pass" AND confidence < 0.6, returns "flag"
// On LLM parse failure: returns conservative { verdict: "flag", category: "parse_error", confidence: 0, risks: [] }
// On LLM call failure: throws

// Evaluate task execution means
const verdict: EthicsVerdict = await gate.checkMeans(
  "task-uuid",                   // taskId: string
  "Run automated tests",        // taskDescription: string
  "Execute via npm test"        // means: string
);
// Behaves identically to check() but builds a means-specific prompt

// Retrieve persisted logs
const logs: EthicsLog[] = gate.getLogs();                          // all logs
const logs = gate.getLogs({ subjectId: "goal-uuid" });             // filter by subject
const logs = gate.getLogs({ verdict: "flag" });                    // filter by verdict
const logs = gate.getLogs({ subjectId: "goal-uuid", verdict: "pass" }); // combined
```

### Persistence

Logs are written to: `<stateManager.baseDir>/ethics/ethics-log.json`
Format: full JSON array (read-all → append → write-all pattern).

### LLM Response Format Expected

The LLM must return bare JSON (no markdown) matching:
```json
{
  "verdict": "pass",
  "category": "safe",
  "reasoning": "This goal is clearly safe and ethical.",
  "risks": [],
  "confidence": 0.95
}
```

**Test fixtures from `tests/ethics-gate.test.ts`:**
```ts
const PASS_VERDICT_JSON = JSON.stringify({
  verdict: "pass", category: "safe",
  reasoning: "This goal is clearly safe and ethical.",
  risks: [], confidence: 0.95
});

const REJECT_VERDICT_JSON = JSON.stringify({
  verdict: "reject", category: "illegal",
  reasoning: "This goal involves clearly illegal activities.",
  risks: ["illegal activity", "potential harm to others"], confidence: 0.99
});

const FLAG_VERDICT_JSON = JSON.stringify({
  verdict: "flag", category: "privacy_concern",
  reasoning: "This goal involves collecting user data, which may raise privacy concerns.",
  risks: ["potential privacy violation", "data misuse"], confidence: 0.70
});

// Low confidence triggers auto-flag of "pass" → "flag":
const LOW_CONFIDENCE_PASS_JSON = JSON.stringify({
  verdict: "pass", category: "ambiguous",
  reasoning: "The goal seems OK but the description is too vague to be sure.",
  risks: ["ambiguous scope"], confidence: 0.30
});
```

---

## 3. SessionManager

**Source:** `src/session-manager.ts`

### Constructor

```ts
import { SessionManager, DEFAULT_CONTEXT_BUDGET } from "./src/session-manager.js";

const manager = new SessionManager(stateManager);  // StateManager — only dependency
// DEFAULT_CONTEXT_BUDGET = 50_000
```

### Key Public Methods

```ts
// Create a new session
// sessionType: "task_execution" | "observation" | "task_review" | "goal_review"
const session: Session = manager.createSession(
  "task_execution",   // SessionType
  "goal-uuid",        // goalId: string
  "task-uuid",        // taskId: string | null  (null for observation/goal_review)
  50_000              // contextBudget?: number  (optional, default DEFAULT_CONTEXT_BUDGET)
);
// Returns Session with: id, session_type, goal_id, task_id, context_slots[],
//   context_budget, started_at (ISO), ended_at: null, result_summary: null
// Persists to: sessions/<session.id>.json
// Adds to: sessions/index.json

// End a session (mark completed)
manager.endSession(
  session.id,                    // sessionId: string
  "task completed successfully"  // resultSummary: string
);
// Updates: ended_at (ISO), result_summary
// Throws if session not found

// Retrieve a session by ID
const session: Session | null = manager.getSession(sessionId);
// Returns null if not found

// Get all active (not ended) sessions for a goal
const sessions: Session[] = manager.getActiveSessions("goal-uuid");
// Returns Session[] where ended_at === null AND goal_id matches

// ─── Context builders (public) ───

// For task_execution sessions (4 slots, +optional p5 for retry)
const slots: ContextSlot[] = manager.buildTaskExecutionContext(
  "goal-uuid",    // goalId
  "task-uuid",    // taskId
  false           // isRetry?: boolean (default false; adds p5 "previous_attempt_result" if true)
);
// Slots: p1=task_definition_and_success_criteria, p2=target_dimension_current_state,
//        p3=recent_observation_summary, p4=constraints

// For observation sessions (4 slots)
const slots = manager.buildObservationContext(
  "goal-uuid",          // goalId
  ["dim_a", "dim_b"]    // dimensionNames: string[]
);
// Slots: p1=goal_and_dimension_definitions, p2=observation_methods,
//        p3=previous_observation_results, p4=constraints

// For task_review sessions (2 slots)
const slots = manager.buildTaskReviewContext("goal-uuid", "task-uuid");
// Slots: p1=task_definition_and_success_criteria, p2=artifact_access_information

// For goal_review sessions (3 slots)
const slots = manager.buildGoalReviewContext("goal-uuid");
// Slots: p1=goal_definition, p2=state_vector_and_recent_changes, p3=achievement_thresholds
```

### Context Slot Count by Session Type

| SessionType      | Slots | Labels                                                                                      |
|------------------|-------|---------------------------------------------------------------------------------------------|
| task_execution   | 4     | task_definition_and_success_criteria, target_dimension_current_state, recent_observation_summary, constraints |
| observation      | 4     | goal_and_dimension_definitions, observation_methods, previous_observation_results, constraints |
| task_review      | 2     | task_definition_and_success_criteria, artifact_access_information                           |
| goal_review      | 3     | goal_definition, state_vector_and_recent_changes, achievement_thresholds                    |

### Persistence

Sessions stored at: `<baseDir>/sessions/<session_id>.json`
Index at: `<baseDir>/sessions/index.json` (string array of all session IDs)

---

## 4. StrategyManager

**Source:** `src/strategy-manager.ts`

### Constructor

```ts
import { StrategyManager } from "./src/strategy-manager.js";

const manager = new StrategyManager(
  stateManager,  // StateManager — required
  llmClient      // ILLMClient — required
);
```

### Key Public Methods

```ts
// Generate 1–2 strategy candidates via LLM
const candidates: Strategy[] = await manager.generateCandidates(
  "goal-uuid",              // goalId: string
  "word_count",             // primaryDimension: string
  ["word_count", "quality"],// targetDimensions: string[]
  {
    currentGap: 0.7,        // number (0=closed, 1=fully open)
    pastStrategies: [],     // Strategy[] (for context; use [] on first call)
  }
);
// Each candidate has state="candidate"
// Persists to: strategies/<goalId>/portfolio.json

// Activate the first candidate
const active: Strategy = await manager.activateBestCandidate("goal-uuid");
// Sets state="active", started_at=now on the first "candidate" in portfolio
// Throws if no candidates exist

// Transition a strategy state
manager.updateState(
  strategyId,          // string
  "completed",         // StrategyState: "candidate"|"active"|"completed"|"terminated"|"evaluating"|"suspended"
  { effectiveness_score: 0.85 }  // optional metadata
);
// Valid transitions: candidate→active, active→completed|terminated|evaluating,
//   evaluating→active|terminated, suspended→active|terminated
// Throws on invalid transition or not found

// React to stall detection
const newStrategy: Strategy | null = await manager.onStallDetected(
  "goal-uuid",  // goalId
  2             // stallCount: number (returns null if < 2)
);
// stallCount >= 2: terminates current active strategy, generates new candidates, activates best
// Returns the newly activated strategy, or null if generation/activation fails

// Get currently active strategy (or null)
const active: Strategy | null = manager.getActiveStrategy("goal-uuid");

// Get full portfolio (or null if never persisted)
const portfolio: Portfolio | null = manager.getPortfolio("goal-uuid");

// Get strategy history (terminated/completed only)
const history: Strategy[] = manager.getStrategyHistory("goal-uuid");
```

### LLM Response Format Expected by generateCandidates

The LLM must return a JSON array in a markdown code block:
```json
[
  {
    "hypothesis": "string — the core bet/approach",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 10,
      "duration": { "value": 14, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]
```

**Test fixture from `tests/strategy-manager.test.ts`:**
```ts
const CANDIDATE_RESPONSE_ONE = `\`\`\`json
[
  {
    "hypothesis": "Increase daily writing output by dedicating the first 2 hours of each day to writing",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 10,
      "duration": { "value": 14, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]
\`\`\``;
```

### Persistence

- Portfolio: `<baseDir>/strategies/<goalId>/portfolio.json`
- History: `<baseDir>/strategies/<goalId>/strategy-history.json`
- In-memory index (`Map<strategyId, goalId>`) — rebuilt from portfolio on `getPortfolio()` call

---

## 5. GoalNegotiator

**Source:** `src/goal-negotiator.ts`

### Constructor

```ts
import { GoalNegotiator, EthicsRejectedError } from "./src/goal-negotiator.js";
import { EthicsGate } from "./src/ethics-gate.js";
import { ObservationEngine } from "./src/observation-engine.js";

const ethicsGate = new EthicsGate(stateManager, llmClient);
const observationEngine = new ObservationEngine(stateManager, llmClient);

const negotiator = new GoalNegotiator(
  stateManager,       // StateManager — required
  llmClient,          // ILLMClient — required
  ethicsGate,         // EthicsGate — required
  observationEngine   // ObservationEngine — required
);
```

### Key Public Methods

```ts
// ─── negotiate() — main entry point, 6-step flow ───
const result = await negotiator.negotiate(
  "Achieve 80% test coverage",   // rawGoalDescription: string
  {
    deadline: "2026-06-01",      // optional ISO date string
    constraints: ["No new infra"], // optional string[]
    timeHorizonDays: 90,         // optional number (default: 90)
  }
);
// Returns: { goal: Goal, response: NegotiationResponse, log: NegotiationLog }
//
// Steps:
//   0. EthicsGate.check() — throws EthicsRejectedError if verdict="reject"
//   1. Parse options
//   2. Dimension decomposition (LLM call #2)
//   3. Baseline observation (null for new goals)
//   4. Feasibility evaluation — one LLM call per dimension (calls #3..N)
//   5. Response generation (LLM call)
//
// Persists goal to: goals/<goalId>/...
// Persists log to: goals/<goalId>/negotiation-log.json
//
// LLM call sequence for a 2-dimension goal (happy path):
//   call 1: ethics verdict (via EthicsGate)
//   call 2: dimension decomposition → JSON array
//   call 3: feasibility for dim 1 → JSON object
//   call 4: feasibility for dim 2 → JSON object
//   call 5: response message → plain text

// ─── decompose() — break a goal into subgoals ───
const result = await negotiator.decompose(
  "parent-goal-uuid",   // goalId: string
  parentGoal            // Goal object
);
// Returns: { subgoals: Goal[], rejectedSubgoals: Array<{ description, reason }> }
// LLM call sequence:
//   call 1: subgoal list → JSON array
//   call N: one EthicsGate.check() per subgoal

// ─── renegotiate() — re-evaluate an existing goal ───
const result = await negotiator.renegotiate(
  "existing-goal-uuid",  // goalId: string
  "stall",               // trigger: "stall" | "new_info" | "user_request"
  "Optional context"     // context?: string
);
// Returns same shape as negotiate()
// Loads existing goal from StateManager, re-runs full 5-step flow
// Can use quantitative feasibility path if dimension has history with change_rate

// ─── getNegotiationLog() ───
const log: NegotiationLog | null = negotiator.getNegotiationLog("goal-uuid");
// Reads from: goals/<goalId>/negotiation-log.json

// ─── Static utility ───
GoalNegotiator.calculateRealisticTarget(
  baseline,        // number
  changeRate,      // number (per day)
  timeHorizonDays  // number
): number
// Returns: baseline + changeRate * timeHorizonDays * 1.3
```

### EthicsRejectedError

```ts
// Thrown by negotiate() and renegotiate() when ethics verdict = "reject"
try {
  await negotiator.negotiate("Help me commit fraud");
} catch (err) {
  if (err instanceof EthicsRejectedError) {
    console.log(err.verdict);  // EthicsVerdict — { verdict: "reject", ... }
    console.log(err.message);  // "Goal rejected by ethics gate: <reasoning>"
  }
}
```

### LLM Response Fixtures for Manual Tests

**For negotiate() with 2 dimensions — 5 responses needed:**
```ts
// negotiate() LLM call order:
// [0] = ethics verdict (fed to EthicsGate, which calls LLM internally)
// [1] = dimension decomposition (array)
// [2] = feasibility for dim 1
// [3] = feasibility for dim 2
// [4] = response message (plain text)

const responses = [
  // [0] ethics
  JSON.stringify({ verdict: "pass", category: "safe",
    reasoning: "Clearly safe.", risks: [], confidence: 0.95 }),

  // [1] dimensions
  JSON.stringify([
    { name: "test_coverage", label: "Test Coverage", threshold_type: "min",
      threshold_value: 80, observation_method_hint: "Run coverage tool" },
    { name: "code_quality", label: "Code Quality Score", threshold_type: "min",
      threshold_value: 90, observation_method_hint: "Run linter" },
  ]),

  // [2] feasibility dim 1
  JSON.stringify({ assessment: "realistic", confidence: "high",
    reasoning: "Achievable within time horizon.",
    key_assumptions: ["Current pace maintained"], main_risks: [] }),

  // [3] feasibility dim 2
  JSON.stringify({ assessment: "ambitious", confidence: "medium",
    reasoning: "Ambitious but possible.",
    key_assumptions: ["Increased effort required"],
    main_risks: ["May require extra resources"] }),

  // [4] response message (plain text — NOT JSON)
  "Your goal has been accepted. Let's get started!",
];
```

**IMPORTANT:** `GoalNegotiator` and `EthicsGate` receive the **same** `llmClient` instance in tests. Since `EthicsGate` is constructed separately and injected, they can use separate mock clients if you want to isolate them. The test suite passes the same mock through both constructors, so call indices accumulate across both.

---

## 6. Setup/Teardown Pattern (for all modules)

```ts
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { StateManager } from "./src/state-manager.js";

// Setup
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-test-"));
const stateManager = new StateManager(tmpDir);

// ... instantiate modules with stateManager ...

// Teardown
fs.rmSync(tmpDir, { recursive: true, force: true });
```

---

## 7. Import Paths (ESM with .js extension required)

```ts
import { LLMClient, MockLLMClient } from "./src/llm-client.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "./src/llm-client.js";
import { EthicsGate } from "./src/ethics-gate.js";
import { SessionManager, DEFAULT_CONTEXT_BUDGET } from "./src/session-manager.js";
import { StrategyManager } from "./src/strategy-manager.js";
import { GoalNegotiator, EthicsRejectedError } from "./src/goal-negotiator.js";
import { StateManager } from "./src/state-manager.js";
import { ObservationEngine } from "./src/observation-engine.js";

// Types
import type { EthicsVerdict, EthicsLog, EthicsSubjectType } from "./src/types/ethics.js";
import type { Session, SessionType, ContextSlot } from "./src/types/session.js";
import type { Strategy, Portfolio } from "./src/types/strategy.js";
import type { Goal } from "./src/types/goal.js";
import type { NegotiationLog, NegotiationResponse, DimensionDecomposition } from "./src/types/negotiation.js";
```

---

## 8. Dependency Graph (for instantiation order)

```
StateManager          (no dependencies)
LLMClient / MockLLMClient  (no dependencies)
  ↓
EthicsGate            (StateManager + ILLMClient)
ObservationEngine     (StateManager + ILLMClient)
SessionManager        (StateManager only)
StrategyManager       (StateManager + ILLMClient)
  ↓
GoalNegotiator        (StateManager + ILLMClient + EthicsGate + ObservationEngine)
```

---

## 9. Confidence Labels

All findings above are **Confirmed** — extracted directly from source files and cross-referenced with test files.

Notable behaviors to verify manually:
- **EthicsGate auto-flag threshold:** `confidence < 0.6` (strictly less than; `confidence === 0.6` keeps "pass") — Confirmed from test boundary case at line 216 of `tests/ethics-gate.test.ts`
- **GoalNegotiator LLM call count:** for N dimensions, negotiate() makes `1 (ethics) + 1 (decomp) + N (feasibility) + 1 (response)` = `N+3` total calls — Confirmed from source flow in `src/goal-negotiator.ts`
- **StrategyManager resolveGoalId fallback:** calls `stateManager.listGoalIds()` for disk scan if strategyId not in memory index — relevant if manager is freshly instantiated after restart
