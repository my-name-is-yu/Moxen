# Agentic AI Framework Research — Part 1

**Date**: 2026-03-20
**Purpose**: Identify architectural patterns, novel features, and mechanisms from leading agentic AI frameworks that could inform Motiva's evolution.

---

## 1. LangGraph (LangChain) — v1.0 GA

**What it is**: Graph-based agent orchestration framework. Agents are modeled as nodes in a directed graph with edges defining transitions. State flows through the graph.

### Key Architectural Patterns (vs Motiva)

| Pattern | LangGraph | Motiva |
|---------|-----------|--------|
| Execution model | Directed graph (nodes + edges) | Sequential loop (observe -> gap -> score -> task -> execute -> verify) |
| State | Explicit reducer-driven TypedDict schemas | File-based JSON per goal |
| Persistence | Pluggable checkpointers (Postgres, DynamoDB, SQLite) | File-based (~/.motiva/) |
| Human-in-the-loop | First-class `interrupt` + `Command(resume=...)` | approvalFn DI injection |
| Long-running | Durable execution with automatic resume | Daemon/cron heartbeat |

### Novel Features Motiva Lacks

1. **Time Travel Debugging** [Confirmed]
   - Every state transition creates a checkpoint with unique ID
   - Can replay from any checkpoint (re-execute nodes from that point)
   - Can **fork** from any checkpoint with modified state (explore alternatives)
   - Execution history forms a **branching tree** (like git commits)
   - Use case for Motiva: "What if we had chosen strategy B instead of A at loop iteration 5?" — replay the goal loop from that decision point with different strategy weights

2. **Interrupt/Command Protocol** [Confirmed]
   - `interrupt` halts graph execution at any node, persists state
   - `Command(resume={"decisions": [{"type": "approve|edit|reject"}]})` resumes with human decision
   - Three decision types: approve (proceed), edit (modify args), reject (with explanation)
   - Motiva's approvalFn is binary (true/false). LangGraph allows **editing the action before approval**.

3. **Graph-Based Conditional Routing** [Confirmed]
   - Edges can be conditional functions that inspect state and route to different nodes
   - Enables dynamic workflow topology at runtime
   - Motiva's loop is fixed-order; LangGraph can skip/add steps dynamically

4. **Production Checkpointer Ecosystem** [Confirmed]
   - DynamoDBSaver (AWS), AsyncPostgresSaver, SqliteSaver, InMemorySaver
   - Automatic crash recovery — server restarts mid-workflow, resumes exactly
   - Motiva relies on file-based state; no crash recovery mid-loop

### Relevance to Motiva

- **HIGH**: Time Travel for strategy debugging — "fork from observation N, try different strategy"
- **HIGH**: Interrupt with edit capability — let user modify task parameters before execution
- **MEDIUM**: Checkpointer abstraction — pluggable persistence backends
- **LOW**: Graph topology — Motiva's fixed loop is by design (domain-independent)

---

## 2. CrewAI — Multi-Agent Collaboration

**What it is**: Role-playing multi-agent framework. Agents have role, goal, backstory. Two modes: Crews (autonomous collaboration) and Flows (event-driven pipelines).

### Key Architectural Patterns (vs Motiva)

| Pattern | CrewAI | Motiva |
|---------|--------|--------|
| Agent model | Role-defined personas (role + goal + backstory) | Adapter-based delegation (claude-code-cli, openai-codex, etc.) |
| Collaboration | Agents autonomously delegate to each other | Motiva is sole orchestrator; agents don't talk to each other |
| Process modes | Sequential, hierarchical (auto-manager), consensual | Single orchestrator loop |
| Memory | 4-type: short-term, long-term, entity, contextual | 3-layer: working, short-term, long-term |

### Novel Features Motiva Lacks

1. **Hierarchical Process with Auto-Generated Manager** [Confirmed]
   - CrewAI can auto-generate a "manager agent" that oversees task delegation and reviews outputs
   - Agents don't just execute — they can delegate sub-tasks to other agents
   - Motiva is always the sole delegator; sub-agents never delegate to other sub-agents
   - Potential: For complex goal trees, allow TreeLoopOrchestrator nodes to spawn their own sub-delegations

2. **Entity Memory** [Confirmed]
   - Dedicated memory type for tracking entities (people, objects, concepts) across conversations
   - Separate from short-term/long-term — entity-centric knowledge graph
   - Motiva has KnowledgeGraph but not entity-specific memory with relationship tracking across sessions

3. **Planning Agent** [Confirmed]
   - Specialized agent that creates step-by-step plans BEFORE execution begins
   - Plan is shared with all crew members
   - Motiva generates tasks incrementally per loop; no upfront planning phase
   - Trade-off: Motiva's incremental approach is more adaptive, but lacks "big picture" coordination

4. **Flows: Event-Driven Pipeline with Built-in Memory** [Confirmed]
   - `@listen` decorators trigger methods on events
   - Automatic state management across flow methods
   - 12M+ executions/day in production
   - Motiva's event handling: file queue (~/.motiva/events/) — more primitive

5. **Agentic RAG with Query Rewriting** [Likely]
   - Agents rewrite retrieval queries to optimize results
   - Motiva's VectorIndex does raw cosine similarity without query optimization

### Relevance to Motiva

- **HIGH**: Entity Memory — track entities (repos, services, people) with relationships across goals
- **MEDIUM**: Planning Agent — optional "plan first" mode before entering the loop
- **MEDIUM**: Agent-to-agent delegation for complex sub-trees
- **LOW**: Role/backstory personas — Motiva's CharacterConfigManager already covers this differently

---

## 3. AutoGen (Microsoft) — v0.4 / Microsoft Agent Framework

**What it is**: Event-driven actor framework for multi-agent systems. Rewritten from scratch in v0.4 with async message-passing architecture.

### Key Architectural Patterns (vs Motiva)

| Pattern | AutoGen | Motiva |
|---------|---------|--------|
| Communication | Async message-passing (actor model) | Synchronous loop with file-based state |
| Runtime | SingleThreadedRuntime / DistributedRuntime | Node.js single process / daemon |
| Group coordination | SelectorGroupChat (LLM-selected next speaker) | N/A — single orchestrator |
| Cross-language | Python + .NET interop | TypeScript only |

### Novel Features Motiva Lacks

1. **Selector Group Chat** [Confirmed]
   - Multiple agents discuss a problem; an LLM (or custom function) selects which agent speaks next
   - Enables emergent collaboration — agents build on each other's outputs
   - Motiva never lets agents interact with each other; all flows through the orchestrator
   - Potential: For knowledge acquisition tasks, let a "researcher agent" and "domain expert agent" converse

2. **Distributed Agent Runtime** [Confirmed, experimental]
   - Agents can run on different processes, machines, or organizations
   - Message-passing abstraction means agent location is transparent
   - Motiva assumes local execution; no distributed execution model

3. **Magentic-One: Specialized Agent Team** [Confirmed]
   - Pre-built team: Orchestrator + WebSurfer + FileSurfer + Coder + ComputerTerminal
   - Orchestrator handles task decomposition, progress tracking, corrective actions
   - WebSurfer controls Chromium browser (navigation, clicking, reading)
   - Similar to Motiva's adapter pattern but with richer built-in agent types
   - Potential: Motiva could define "agent archetypes" (web researcher, code writer, data analyst) with pre-configured capabilities

4. **OpenTelemetry-Based Observability** [Confirmed]
   - Industry-standard tracing with OpenTelemetry integration
   - Motiva has ReportingEngine but no structured observability/tracing protocol

5. **Cross-Language Agent Interop** [Confirmed]
   - Agents written in Python can collaborate with agents written in .NET
   - Message types define the interface contract, not the implementation language
   - Motiva is TypeScript-only

### Relevance to Motiva

- **HIGH**: OpenTelemetry tracing — structured observability for the core loop
- **MEDIUM**: Agent conversation/debate pattern for complex decisions
- **MEDIUM**: Pre-built agent archetypes (researcher, coder, analyst)
- **LOW**: Distributed runtime (overkill for Motiva's current scope)
- **LOW**: Cross-language interop (TypeScript ecosystem is sufficient)

---

## 4. OpenAI Agents SDK (formerly Swarm)

**What it is**: Lightweight, Python-first agent framework. Three primitives: Agents, Handoffs, Guardrails. Minimal abstraction layer.

### Key Architectural Patterns (vs Motiva)

| Pattern | OpenAI Agents SDK | Motiva |
|---------|-------------------|--------|
| Agent definition | Agent(name, instructions, tools, handoffs) | Adapter configs in adapter-layer.ts |
| Task routing | Handoff = tool call to transfer_to_X | Motiva selects adapter per task |
| Safety | Input/output guardrails with parallel execution | EthicsGate L1 (rule-based blocklist) |
| Tracing | Built-in tracing for all events | ReportingEngine (reports, not traces) |

### Novel Features Motiva Lacks

1. **Guardrails with Parallel Execution** [Confirmed]
   - Input guardrails validate before agent runs; output guardrails validate after
   - **Tool guardrails** run on every custom function invocation
   - Two modes: parallel (guardrail runs concurrently with agent for latency) or blocking (guardrail completes before agent starts)
   - Motiva's EthicsGate is goal-level only (checked once at negotiation). No per-task or per-tool-invocation guardrails.
   - Potential: Add guardrails to TaskLifecycle — validate each task before and after execution

2. **Structured Output via output_type** [Confirmed]
   - Agent declares its output schema; LLM uses `final_output` tool to produce structured result
   - If no output_type, any non-tool-call message is final output
   - Motiva uses Zod schemas for LLM responses but doesn't have a unified "agent output type" abstraction

3. **RunContext with Typed Dependencies** [Confirmed]
   - `RunContextWrapper[T]` passes typed context (dataclass/Pydantic) through entire execution
   - All tool calls, lifecycle hooks, and callbacks receive the same typed context
   - Motiva's contextProvider is similar but less formalized — not a generic typed container

4. **Lifecycle Hooks** [Confirmed]
   - `on_llm_start`, `on_llm_end` at Runner and Agent level
   - RunHooks observe entire run including handoffs; AgentHooks observe single agent
   - Motiva has no hook system for observing individual LLM calls within the loop

5. **Handoffs as Tools** [Confirmed]
   - Agent delegation is modeled as a tool call (`transfer_to_refund_agent`)
   - LLM decides WHEN to hand off based on context — not hard-coded routing
   - Motiva's adapter selection is deterministic (based on task type/strategy), not LLM-decided

6. **Realtime/Voice Agents** [Confirmed]
   - Voice pipeline: STT -> agent -> TTS with automatic interruption detection
   - Motiva has no voice interface

### Relevance to Motiva

- **HIGH**: Per-task guardrails (input/output validation around every task execution)
- **HIGH**: Lifecycle hooks for LLM call observation (cost tracking, debugging)
- **MEDIUM**: Typed RunContext pattern — formalize contextProvider as generic typed container
- **MEDIUM**: LLM-decided handoffs — let LLM choose adapter for ambiguous tasks
- **LOW**: Voice agents (out of scope for now)

---

## 5. Claude Agent SDK (Anthropic)

**What it is**: General-purpose agent runtime (renamed from Claude Code SDK). Three-layer stack: MCP (protocol) + Agent Skills (capabilities) + SDK (runtime).

### Key Architectural Patterns (vs Motiva)

| Pattern | Claude Agent SDK | Motiva |
|---------|------------------|--------|
| Tool access | 14+ built-in tools (Read, Write, Bash, Glob, etc.) | Task delegation to external agents |
| Context | Agentic search (grep/tail) + compaction + semantic search | ContextProvider with priority-based selection |
| Verification | Rule-based + visual feedback + LLM-as-judge | L1 mechanical + L2 LLM verification |
| Subagents | Isolated context windows, parallel execution | Sequential task execution per loop |

### Novel Features Motiva Lacks

1. **Context Compaction** [Confirmed]
   - Automatic summarization when approaching context window limits
   - Preserves essential information, discards verbose details
   - Motiva's ContextProvider has a fixed top-4/budget system but no compaction — context is either included or excluded

2. **Subagent Isolation with Filtered Return** [Confirmed]
   - Subagents work in isolated context windows
   - Only **relevant information** is sent back to orchestrator (not full context)
   - Motiva receives full task results from agents — no filtering of what comes back
   - Potential: Filter observation results before feeding into gap calculation

3. **Three-Layer Stack: MCP + Skills + Runtime** [Confirmed]
   - MCP servers plug in as tools automatically
   - Skills are portable capability packages
   - Runtime orchestrates everything
   - Motiva's plugin architecture (PluginLoader) is similar but not MCP-native

4. **Visual Feedback Loops** [Confirmed]
   - Agents can take screenshots to verify UI/formatting work
   - Multimodal verification: "does this look right?"
   - Motiva's verification is text/metric-based only — no visual verification capability

5. **Agentic Search for Context Gathering** [Confirmed]
   - Instead of loading entire files, agents use bash commands (grep, tail) to surgically fetch relevant context
   - More efficient than loading full file contents
   - Motiva's observation methods load complete data; no surgical context retrieval

### Relevance to Motiva

- **MEDIUM**: Context compaction — summarize observation history when context budget is tight
- **MEDIUM**: Subagent result filtering — only pass relevant observation data to gap calculation
- **MEDIUM**: MCP integration — expose Motiva's capabilities as MCP servers
- **LOW**: Visual verification (niche use case for Motiva's domain)

---

## Cross-Framework Synthesis: Top Features for Motiva

### Priority 1 — High Impact, Feasible

| Feature | Source | Motiva Gap | Implementation Sketch |
|---------|--------|------------|----------------------|
| **Per-task guardrails** | OpenAI SDK | EthicsGate is goal-level only | Add input/output validation hooks in TaskLifecycle.executeTask() |
| **Time travel / state forking** | LangGraph | No way to replay or fork from past loop iterations | Checkpoint each loop iteration; add `motiva replay --from-iteration N` |
| **Interrupt with edit** | LangGraph | approvalFn is binary yes/no | Extend approval to return `{approve, edit: modifiedTask, reject: reason}` |
| **Lifecycle hooks** | OpenAI SDK | No observation of internal LLM calls | Add hook system: on_llm_start, on_llm_end, on_task_start, on_task_end |

### Priority 2 — Medium Impact, Worth Exploring

| Feature | Source | Motiva Gap | Notes |
|---------|--------|------------|-------|
| **Entity memory** | CrewAI | KnowledgeGraph exists but no entity-centric tracking | Track entities (repos, services, APIs) with relationship persistence across goals |
| **Planning agent mode** | CrewAI | Incremental task discovery only | Optional "plan first" phase before entering the loop; useful for deadline-driven goals |
| **OpenTelemetry tracing** | AutoGen | ReportingEngine is report-level, not trace-level | Structured spans for each loop step; enables external dashboards |
| **Context compaction** | Claude SDK | Context is include-or-exclude | Summarize old observations when context budget is tight |
| **LLM-decided delegation** | OpenAI SDK | Adapter selection is deterministic | For ambiguous tasks, let LLM choose which adapter/agent to use |

### Priority 3 — Lower Impact or Future

| Feature | Source | Notes |
|---------|--------|-------|
| Agent-to-agent conversation | AutoGen | Let sub-agents debate strategies before committing |
| Agent archetypes (WebSurfer, Coder, etc.) | AutoGen/Magentic-One | Pre-configured adapter profiles with capability descriptions |
| MCP server exposure | Claude SDK | Expose Motiva observation/gap/task APIs as MCP tools |
| Query rewriting for retrieval | CrewAI | Optimize VectorIndex queries before search |
| Distributed runtime | AutoGen | Overkill for now; revisit when multi-user is needed |

---

## Observations on Motiva's Unique Position

Features that **none of the researched frameworks have**, which are Motiva's competitive advantages:

1. **Satisficing (good-enough completion)** — All frameworks run until task complete or user stops. None have "this is good enough" judgment.
2. **Multi-dimensional gap analysis** — Frameworks route tasks; Motiva calculates multi-axis gaps with confidence weighting.
3. **Drive system (deadline + dissatisfaction + opportunity)** — No framework has a motivational scoring system for task prioritization.
4. **Goal negotiation with feasibility assessment** — No framework negotiates goals with the user or counter-proposes.
5. **Strategy portfolio management** — No framework manages parallel strategies with rebalancing based on effectiveness.
6. **Trust asymmetry** — No framework has asymmetric trust scoring (failure penalized more than success rewarded).
7. **Long-term goal persistence (months/years)** — All frameworks are session or workflow scoped. None are designed for year-scale goal pursuit.

Motiva is not competing with these frameworks — it sits **above** them as a meta-orchestrator. These frameworks could serve as Motiva's execution layer (new adapter types).

---

## Sources

- [LangGraph Human-in-the-Loop Docs](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- [LangGraph Time Travel Concepts](https://langchain-ai.github.io/langgraph/concepts/time-travel/)
- [LangGraph GitHub](https://github.com/langchain-ai/langgraph)
- [LangGraph Deep Dive (2026)](https://www.mager.co/blog/2026-03-12-langgraph-deep-dive/)
- [CrewAI Documentation](https://docs.crewai.com/)
- [CrewAI Flows](https://docs.crewai.com/en/concepts/flows)
- [CrewAI GitHub](https://github.com/crewAIInc/crewAI)
- [AutoGen v0.4 Launch Blog](https://devblogs.microsoft.com/autogen/autogen-reimagined-launching-autogen-0-4/)
- [AutoGen GitHub](https://github.com/microsoft/autogen)
- [Magentic-One Documentation](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/magentic-one.html)
- [Microsoft Agent Framework Overview](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [OpenAI Agents SDK Documentation](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- [OpenAI Agents SDK Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [Claude Agent SDK Blog](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
- [Claude Agent SDK npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [AI Agent Frameworks Compared (2026)](https://designrevision.com/blog/ai-agent-frameworks)
- [OpenAgents Framework Comparison](https://openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared)
