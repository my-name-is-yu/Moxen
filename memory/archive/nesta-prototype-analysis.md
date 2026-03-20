# Nesta Prototype Analysis

**Project**: Contradiction Distiller (located at `/Users/yuyoshimuta/Documents/dev/Concept-Hackathon/nesta`)
**Date analyzed**: 2026-03-20
**Language**: Python (backend), vanilla JS/HTML/CSS (frontend)
**Dependencies**: anthropic SDK, Flask (web version only)
**LLM**: claude-sonnet-4-5-20250929 (hardcoded)

---

## What Nesta Is

A **multi-agent debate loop for startup decision-making**. Given a set of contradictory startup constraints (e.g., "grow 10x" vs. "stay lean"), it runs a structured adversarial debate among three LLM-powered agents to surface hidden contradictions, synthesize resolutions, and converge on a distilled problem structure.

**Problem it solves**: Founders hold contradictory beliefs simultaneously without realizing it. Nesta forces those contradictions into the open through adversarial multi-agent reasoning, producing a structured representation of what the real dilemma is and what tradeoffs must be made.

---

## Directory Structure

```
nesta/
  demo.py              — CLI version (terminal with ANSI colors)
  web.py               — Flask + SSE web version
  templates/
    index.html          — Single-page web UI (dark theme, ~750 lines)
  __pycache__/          — compiled bytecode (demo only)
```

Only 3 meaningful files. No package.json, no requirements.txt, no README. Pure hackathon prototype.

---

## Core Architecture

### The Debate Loop (3 agents, max 5 rounds)

```
User Input (free text constraints)
    |
    v
[PARSER] -- LLM extracts structured representation -->
    |
    v
  +--------------------------------------------------+
  | DEBATE ROUND (repeats 3-5 times)                 |
  |                                                   |
  |  [CHALLENGER] -- attacks representation           |
  |       |                                           |
  |  [SYNTHESIZER] -- reframes + resolves tensions    |
  |       |                                           |
  |  [AUDITOR] -- validates consistency, gates exit   |
  |       |                                           |
  |  Convergence check (min 3 rounds, auditor vote)   |
  +--------------------------------------------------+
    |
    v
  FINAL: Distilled Problem Structure
```

### The Shared State: Problem Representation

Central mutable data structure passed between all agents:

```json
{
  "constraints": [
    { "id": "C1", "statement": "...", "dimension": "growth|survival|...",
      "polarity": "positive|negative", "tension_tags": ["..."] }
  ],
  "tensions": [
    { "id": "T1", "between": ["C1", "C3"], "description": "...",
      "severity": "high|medium|low", "resolved": false }
  ],
  "meta": {
    "core_dilemma": "...",
    "resolution_hypothesis": null,
    "round": 0
  }
}
```

### The Mutation Engine (Key Pattern)

Each agent returns `representation_mutations` -- a list of declarative operations:
- `update_constraint` / `add_constraint`
- `update_tension` / `add_tension` / `resolve_tension`
- `update_meta`

The `apply_mutations()` function (lines 287-339 in demo.py) applies these mutations immutably (deepcopy + apply). This is the **core architectural pattern**: agents don't return new state directly; they return a diff of mutations that are applied deterministically.

---

## Key Source Files

### 1. `demo.py` (603 lines) -- CLI version

- **Lines 143-174**: PARSE_SYSTEM prompt -- extracts structured constraints + tensions from free text
- **Lines 190-282**: Three agent system prompts (CHALLENGER, SYNTHESIZER, AUDITOR)
- **Lines 287-339**: `apply_mutations()` -- the mutation engine
- **Lines 344-402**: Agent runners (`run_challenger`, `run_synthesizer`, `run_auditor`) -- each calls LLM, parses JSON, applies mutations
- **Lines 90-138**: `safe_json_parse()` -- robust JSON extraction (handles markdown fences, truncated JSON, brace-counting repair)
- **Lines 531-603**: Main loop -- banner, input, parse, debate loop with convergence check
- **Lines 44-86**: Terminal drawing helpers (ANSI box drawing, color palette)

### 2. `web.py` (471 lines) -- Flask + SSE version

- Duplicates all prompts and mutation engine from demo.py (no shared module)
- **Lines 328-331**: `sse_event()` helper -- wraps data as SSE
- **Lines 341-466**: `/api/run` POST endpoint -- SSE streaming generator that yields events for each agent step
- Saves results to `outputs/run_YYYYMMDD_HHMMSS.json`

### 3. `templates/index.html` (753 lines) -- Web UI

- Dark theme GitHub-style design (CSS variables, grid layout)
- Sidebar: input textarea + progress tracker + download link
- Main area: collapsible round sections with agent cards
- **All DOM construction uses safe `el()` builder** (line 293-303) -- no innerHTML, XSS-safe
- SSE client using fetch + ReadableStream (lines 714-738)
- Representation cards show constraints (color-coded by dimension), tensions (resolved/unresolved), and meta

---

## Unique / Interesting Patterns

### 1. Mutation-Based State Evolution (not replacement)
Agents don't return a new state. They return a **mutation list** -- declarative operations on the shared representation. This:
- Makes agent outputs composable and auditable
- Prevents agents from silently dropping information
- Creates a natural diff/changelog of what each agent changed
- Allows graceful handling of malformed mutations (try/except per mutation)

### 2. Adversarial Agent Roles (Challenger/Synthesizer/Auditor)
Not just "multiple perspectives" -- the three roles form a **dialectical triad**:
- **Challenger** (thesis attack): surfaces hidden assumptions, false dichotomies, proxy constraints
- **Synthesizer** (synthesis): finds higher-order patterns, resolves tensions by reframing
- **Auditor** (verification): gates convergence, catches "papered over" resolutions, prevents false convergence

The Auditor explicitly checks for "false convergence" -- resolutions that look clean but dodge the real tension.

### 3. Convergence Gating
- Minimum 3 rounds before convergence is allowed
- Maximum 5 rounds (hard cap)
- Convergence requires: Auditor declares "converged" AND `new_contradictions_found == 0`
- This prevents both premature convergence and infinite loops

### 4. Tension as First-Class Object
Contradictions/tensions have their own IDs, severity levels, and resolution status. They're tracked across rounds, not just mentioned in prose. The `between` field links tensions to specific constraints (C1 <-> C3), creating a graph structure.

### 5. Robust LLM JSON Parsing
`safe_json_parse()` handles:
- Markdown code fences (including unclosed)
- JSON embedded in surrounding text (brace-depth counting)
- Truncated JSON (repairs by closing open braces/brackets)
- Trailing incomplete strings stripped before repair

### 6. SSE Streaming for Real-Time Debate Visualization
The web version streams each agent's progress and output via SSE, enabling the UI to show the debate unfolding in real time. Events: `parser`, `challenger`, `synthesizer`, `auditor`, `representation`, `convergence`, `final`, `error`.

---

## Relevance to Motiva

### Directly Applicable Ideas

1. **Mutation-based state evolution** -- Motiva's ObservationEngine and GoalNegotiator could benefit from this pattern. Instead of agents returning full state replacements, they could return mutation lists. This would:
   - Make observation results more auditable
   - Allow partial application and rollback
   - Enable better diffing for the reporting engine

2. **Adversarial verification before convergence** -- Motiva's SatisficingJudge decides "good enough." Adding a Challenger-like mechanism that attacks the "done" assessment before accepting it could prevent premature goal completion. The Auditor pattern (explicit "false convergence" detection) maps directly to Motiva's risk of satisficing too early.

3. **Tension/contradiction as first-class objects** -- Motiva tracks gaps between current state and goals, but doesn't model _contradictions between goals_. When a user has conflicting goals (e.g., "increase test coverage" vs. "ship fast"), Motiva currently has no mechanism to surface this. The tension model from nesta (with severity, resolution status, and constraint links) could extend GoalDependencyGraph.

4. **Convergence gating pattern** -- The min-rounds + auditor-vote + zero-new-contradictions triple gate is more sophisticated than a simple threshold check. Motiva's core loop could adopt a similar multi-condition convergence gate for goal completion assessment.

5. **Structured problem decomposition via LLM** -- nesta's Parser stage (free text -> structured constraints + tensions) is essentially what Motiva's `suggestGoals` and `negotiate()` do. The dimension/polarity/tension_tags schema is a clean template for structuring user intent.

### Architectural Contrasts

| Aspect | Nesta | Motiva |
|--------|-------|--------|
| State model | Single mutable representation (constraints + tensions + meta) | Multi-dimensional goal state (thresholds, confidence, drives) |
| Agent pattern | 3 fixed adversarial roles | Configurable adapters (any CLI/API agent) |
| Loop purpose | Converge on problem understanding | Converge on goal achievement |
| LLM usage | Every agent is an LLM call | LLM calls for observation/negotiation, execution delegated |
| Persistence | In-memory + optional JSON dump | File-based JSON state (~/.motiva/) |
| Execution | Stateless (one run) | Continuous loop (daemon/cron capable) |

### Key Insight for Motiva

Nesta treats **problem understanding** as the goal, not problem solving. This is a useful mental model for Motiva's observation/gap phase: before pursuing a goal, Motiva could run a "contradiction distillation" step to ensure the goal set is internally consistent. This would prevent the scenario where Motiva successfully achieves one goal while making another impossible.

---

## Code Quality Notes

- No tests, no type hints beyond basic annotations, no README
- Significant code duplication between demo.py and web.py (all prompts, mutation engine, agent runners copied verbatim)
- No error handling for API key missing or rate limits
- Hardcoded model (`claude-sonnet-4-5-20250929`)
- Web UI is well-crafted (XSS-safe DOM construction, responsive grid, dark theme) -- clearly demo-polished
- The `safe_json_parse` function is production-quality despite the prototype context
