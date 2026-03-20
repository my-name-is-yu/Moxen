# Agentic AI Framework Research — Part 2 (2026-03-20)

Research into cutting-edge agent orchestration patterns across 7 major frameworks/products.
Focus: concrete mechanisms applicable to Motiva's orchestrator architecture.

---

## 1. Devin / Cognition — Autonomous Coding Agent

### Architecture
- Sandboxed environment with terminal + code editor + browser (not just LLM chat)
- "Architectural Brain" decomposes tasks into step-by-step plans before writing code
- v3.0 (2026): **dynamic re-planning** — hits a roadblock → alters strategy without human intervention
- Runs on custom inference stack (Cerebras partnership) for fast iteration loops

### Verification: Self-Healing Loop
- **Write → Test → Debug → Fix cycle**: when code fails compilation/tests, reads error logs, adds debugging statements, fixes, re-runs — iterates until all tests pass
- v2.2+: **computer-use self-verification** — Devin opens browser/UI to visually verify its own work before submitting PR
- 67% PR merge rate (2025) vs 34% prior year — key quality metric

### Planning & Execution
- Task classification: clear requirements (4-8h junior tasks) → high success; ambiguous scope → poor results
- **Fleet parallelization**: identical tasks across multiple repos simultaneously (batch migration pattern)
- Struggles with mid-task requirement changes (weak at interactive replanning)

### Motiva Relevance
- **Self-verification via tool use** (not just test results) — Motiva's L1/L2 verification could benefit from "use the tool to check your own work" pattern
- **Dynamic re-planning on roadblock** — Motiva's StallDetector triggers strategy change, but Devin does it within a single task execution
- **Fleet pattern** — parallel identical tasks across repos is unexplored in Motiva

Sources: [Cognition Blog — 2025 Performance Review](https://cognition.ai/blog/devin-annual-performance-review-2025), [Devin 2.0](https://cognition.ai/blog/devin-2), [Devin 2.2](https://cognition.ai/blog/introducing-devin-2-2)

---

## 2. Manus AI — General-Purpose Autonomous Agent

### Architecture: Event Stream + One-Action-Per-Iteration
- **Agent loop**: Analyze state → Plan/Select action → Execute in sandbox → Observe result → Append to event stream → Repeat
- **One tool action per iteration** — prevents runaway multi-step execution; forces observation after each action
- Each user gets a **fully isolated cloud VM** (networking, filesystem, browser, dev tools)
- Foundation models: Claude 3.5 Sonnet (primary reasoning) + Alibaba Qwen fine-tuned variants (task-specific)

### Memory: Three-Tier System
1. **Event Stream Context** — immediate session history (potentially summarized when too long)
2. **Persistent Scratchpad** — file-based `todo.md` for progress tracking, intermediate results externalized to files
3. **Knowledge Store** — vector-indexed reference materials

### Planning Module
- Planner generates ordered step lists at task init (step number, description, status)
- "Plan" events injected into event stream
- **todo.md tracking** — agent updates after each step completion
- Re-planning triggered when significant task changes emerge

### CodeAct Paradigm
- Instead of rigid tool-call APIs, agent generates executable Python code as its action mechanism
- Can combine multiple operations, conditional logic, and library usage in a single action
- More flexible than fixed tool schemas

### Multi-Agent Decomposition
- **Planner Agent** — strategist, breaks problems into sub-tasks
- **Execution Agent** — tool interactions, task execution
- **Monitoring Agent** — evaluates progress, adjusts strategies
- **Learning Agent** — improves through execution experience

### Motiva Relevance
- **File-based todo.md externalization** — Motiva already does state persistence to `~/.motiva/`, but the "scratchpad" pattern for working memory within a task is novel
- **One-action-per-iteration with mandatory observation** — Motiva's core loop already follows this (observe → gap → task → execute → verify), but at a higher level; within task execution, the adapter just runs
- **CodeAct** — instead of fixed adapter commands, generating executable code could make Motiva more flexible
- **Monitoring Agent as separate concern** — Motiva combines monitoring into CoreLoop; dedicated monitoring agent could catch drift faster

Sources: [Manus Architecture Gist](https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f), [Leaked System Prompt](https://github.com/jujumilk3/leaked-system-prompts/blob/main/manus_20250310.md), [arxiv paper](https://arxiv.org/html/2505.02024v1)

---

## 3. Claude Code — Subagent Orchestration

### Architecture: Task Tool + Agent Teams
- **Subagents**: each runs in own context window with custom system prompt, specific tool access, independent permissions
- **Agent Teams** (experimental): multi-session orchestration with a team lead that coordinates, assigns tasks, and synthesizes results. Teammates communicate directly (not just through boss)
- **Task Tool**: 3 execution modes — sequential (default, conservative), parallel (for independent domains), hierarchical

### Cost Optimization Pattern
- Main session on Opus (complex reasoning) + sub-agents on Sonnet (focused tasks)
- Significant cost reduction without quality loss on well-scoped sub-agent work

### Tool Use Patterns
- 15+ specialized tools: search/navigation, execution (terminal, browser), MCP integration
- Each subagent gets a scoped tool set — principle of least privilege

### Multi-Agent Coordination
- **Boss-Worker model**: central agent dispatches, workers report back
- Agent Teams adds **peer-to-peer communication** — teammates can share discoveries mid-task
- Scope boundaries: each worker owns specific files to prevent conflicts

### Motiva Relevance
- **Tiered model strategy** — Motiva could use expensive models for goal negotiation / gap assessment, cheap models for routine observation
- **Peer-to-peer agent communication** — Motiva's agents currently only report to CoreLoop; direct agent-to-agent handoff could reduce latency
- **Scoped tool sets per subagent** — each Motiva task could restrict which tools/adapters are available

Sources: [Claude Code Subagent Docs](https://code.claude.com/docs/en/sub-agents), [Agent Teams Guide](https://claudefa.st/blog/guide/agents/agent-teams), [Task Tool DEV.to](https://dev.to/bhaidar/the-task-tool-claude-codes-agent-orchestration-system-4bf2)

---

## 4. Cursor / Windsurf — AI IDE Agent Patterns

### Cursor: Merkle Tree Context Sync
- **Problem**: RAG systems have high sync latency when files change during agent work
- **Solution**: Merkle trees (hierarchical cryptographic hashes) — when a file changes, only update specific hash paths. Compare root hash to detect drift in milliseconds
- Every few minutes, diff local vs server Merkle trees → re-index only changed files
- Enables **always-current agent worldview** with minimal bandwidth

### Cursor: Background Agents
- Cloud VMs that work concurrently with developer's local session
- Each agent runs in **isolated VM with full dev environment**
- Can execute code, run tests, make broad changes without blocking local work

### Cursor: Composer Mode
- Developer describes high-level task → AI plans architecture, generates new files, edits existing simultaneously
- Multi-file orchestration in single operation

### Windsurf: Cascade — Dual-Track Planning
- **Specialized planning agent** runs in background, continuously refining long-term plan
- **Execution model** focuses on short-term actions based on that plan
- Separation of planning and execution into concurrent tracks

### Windsurf: Memory System
- **Auto-generated memories**: Cascade autonomously creates memories from corrections/preferences
- Memories persist across sessions (not just conversation)
- Multi-layer context: real-time edit tracking + Rules files + persistent Memories
- **Problem identified**: IDE agents without session memory "re-discover codebases daily" — memory is competitive moat

### Motiva Relevance
- **Merkle tree for state change detection** — Motiva's observation engine could use content hashing to detect actual file changes vs no-change, reducing unnecessary LLM observation calls
- **Dual-track planning** (background planner + foreground executor) — Motiva's CoreLoop could run a parallel "strategy refinement" process while tasks execute
- **Auto-generated memories from corrections** — Motiva could build a correction/preference memory automatically when users renegotiate goals or override decisions
- **Background agent pattern** — Motiva tasks could run in isolated environments without blocking the main loop

Sources: [Cursor Architecture Case Study](https://medium.com/@khayyam.h/designing-high-performance-agentic-systems-an-architectural-case-study-of-the-cursor-agent-ab624e4a0a64), [Cursor Background Agents](https://docs.cursor.com/en/background-agent), [Windsurf Cascade](https://windsurf.com/cascade), [Windsurf Memory Analysis](https://memu.pro/blog/windsurf-ide-ai-coding-agent-memory)

---

## 5. Google ADK + A2A Protocol — Agent Interoperability

### A2A Protocol Core Concepts
- **AgentCard**: JSON "business card" hosted at `/.well-known/agent-card.json` describing agent capabilities
- Digitally signable via JWS (RFC 7515) for authenticity
- **Agent Discovery**: Well-Known URI, Registries/Catalogs, Direct Configuration
- **Task-oriented communication**: lifecycle can be immediate or long-running
- v0.2: stateless interactions + OpenAPI-like authentication schema
- v1.0.0-rc stage as of 2025

### ADK Evaluation Framework
- **Golden Dataset**: "perfect" interactions as ground truth — exact tool call trajectories (e.g., `check_order → verify_eligibility → refund_transaction`)
- LLM-based metrics:
  - `final_response_match_v2` — LLM Judge for response quality
  - `hallucinations_v1` — checks if answers are supported by tool outputs
  - `safety_v1` — harmful content detection
  - `rubric_based_final_response_quality_v1` — custom evaluation rules
- Evaluations run from CLI, web UI, or CI/CD pipelines

### ADK Guardrail Callbacks (4 intercept points)
1. `before_model_callback` — validate inputs before LLM call
2. `after_model_callback` — moderate model output
3. `before_tool_callback` — validate tool parameters, enforce policies
4. `after_tool_callback` — verify tool results

### ADK Security Plugins
- **Gemini-as-Judge**: Flash Lite evaluates inputs/outputs for safety, prompt injection, jailbreak detection
- Plugin-based: configure once, apply globally to all agents in runner
- **In-tool guardrails**: deterministic policy enforcement (e.g., restrict DB queries to allowed tables)

### Motiva Relevance
- **AgentCard pattern for capability advertising** — each Motiva adapter could publish an AgentCard describing what it can do, enabling dynamic adapter selection
- **Golden Dataset evaluation** — Motiva could define expected tool-call trajectories for known goal types and evaluate whether actual execution matches
- **4-point callback guardrails** — Motiva's EthicsGate is currently pre-execution only; adding post-execution and pre/post-LLM checkpoints would be more comprehensive
- **Hallucination check against tool outputs** — verify LLM observations against actual tool/command outputs (addresses bug #4 from M3 analysis)

Sources: [A2A Protocol Spec](https://a2a-protocol.org/latest/specification/), [ADK Safety Docs](https://google.github.io/adk-docs/safety/), [ADK Evaluation](https://google.github.io/adk-docs/evaluate/), [A2A Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)

---

## 6. Amazon Bedrock Agents + Strands — Enterprise Orchestration

### Orchestration Modes
1. **Default (ReAct)**: Reason-and-Action loop — agent develops plan, executes step by step
2. **Supervisor Mode**: supervisor agent analyzes input, invokes sub-agents serially or in parallel, consults knowledge bases
3. **Supervisor with Routing Mode**: simple requests routed directly to specialist (bypass full orchestration); complex queries fall back to full supervisor mode
4. **Custom Orchestration**: Lambda functions with arbitrary orchestration logic

### Strands Agents SDK — GraphBuilder
- Open-source framework for production AI agents
- **GraphBuilder API**: wire agents into directed acyclic workflows
  - Define which agents participate
  - Specify data flow between agents
  - Control where user input enters
  - Handle agent communication topology
- Multi-agent composition patterns:
  - Agent-as-tool (one agent invokes another as a tool)
  - Handoff (pass control between agents)
  - Parallel coordination

### AgentCore Evaluations (re:Invent 2025)
- Automated assessment: task completion, edge case handling, consistency
- Built-in evaluation tooling for production agent quality

### Motiva Relevance
- **Routing mode** — Motiva could implement fast-path routing for simple/known tasks (skip full observe → gap → score cycle) and full orchestration for complex tasks
- **GraphBuilder for workflow definition** — Motiva's core loop is fixed; a configurable DAG of agent steps could make it more flexible
- **Agent-as-tool composition** — Motiva agents could be composed where one goal's execution output feeds another goal's observation
- **AgentCore Evaluations** — standardized evaluation for Motiva's task execution quality

Sources: [Bedrock Multi-Agent Collaboration](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent-collaboration.html), [Bedrock Orchestration Strategy](https://docs.aws.amazon.com/bedrock/latest/userguide/orch-strategy.html), [Strands Agents Blog](https://aws.amazon.com/blogs/machine-learning/customize-agent-workflows-with-advanced-orchestration-techniques-using-strands-agents/), [AgentCore Overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)

---

## 7. Microsoft Semantic Kernel — Agent Framework

### 5 Orchestration Patterns (Unified API)
1. **Sequential** — agent A output → agent B input → agent C input (pipelines)
2. **Concurrent** — broadcast task to all agents, collect results independently (parallel analysis, ensemble decisions)
3. **Handoff** — dynamic control transfer based on context/rules (escalation, expert routing)
4. **Group Chat** — all agents participate in conversation, coordinated by group manager (RoundRobinGroupChatManager or custom)
5. **Magentic** — inspired by MagenticOne research; generalist multi-agent collaboration for complex tasks

### Unified Interface
- All patterns share same construction/invocation API
- Swap orchestration pattern without rewriting agent logic
- Consistent async result handling

### Plugin Architecture
- Plugins extend functionality: simple API calls to complex business logic
- AI agents auto-select and invoke appropriate plugins
- Planner auto-decomposes complex requests into plugin call sequences

### Framework Evolution: SK + AutoGen → Microsoft Agent Framework
- Combines SK's enterprise orchestration with AutoGen's multi-agent research patterns
- Production-grade durability + enterprise controls
- Python and .NET support (Java planned)

### Motiva Relevance
- **Handoff pattern** — Motiva's strategy switching is currently score-driven; explicit handoff rules ("if trust < X, hand off to human") would be cleaner
- **Group Chat for brainstorming** — multiple Motiva strategies could "discuss" approach before committing (ensemble strategy selection)
- **Concurrent + aggregation** — Motiva's observation could run multiple observation methods concurrently and aggregate (already partially implemented with cross-validation)
- **Unified orchestration API** — Motiva's CoreLoop hardcodes the orchestration; making it pluggable (sequential vs concurrent vs handoff) would increase flexibility
- **Auto-planner for plugin sequences** — Motiva's TaskLifecycle could auto-compose plugin actions based on goal requirements

Sources: [SK Agent Orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/), [SK Multi-Agent Blog](https://devblogs.microsoft.com/semantic-kernel/semantic-kernel-multi-agent-orchestration/), [Microsoft Agent Framework](https://visualstudiomagazine.com/articles/2025/10/01/semantic-kernel-autogen--open-source-microsoft-agent-framework.aspx)

---

## Cross-Cutting Patterns (Applicable to Motiva)

### 1. Self-Verification via Tool Use
- **Devin**: opens browser to visually verify its own output
- **Pattern**: after task execution, use a DIFFERENT tool/method to verify the result (not just "did the command succeed")
- **Motiva application**: L2 verification could use a different adapter or method than L1

### 2. File-Based Working Memory (Scratchpad)
- **Manus**: `todo.md` as progress tracker, intermediate results in files
- **Windsurf**: auto-generated memories from corrections
- **Pattern**: externalize intermediate reasoning to persistent files, not just LLM context
- **Motiva application**: per-goal scratchpad file for accumulating observations, hypotheses, and intermediate results

### 3. Dual-Track Planning (Background Planner + Foreground Executor)
- **Windsurf**: specialized planning agent runs continuously in background
- **Devin**: dynamic re-planning on roadblock
- **Pattern**: separate the "what to do next" reasoning from "doing it"
- **Motiva application**: StrategyManager could run as a background process that continuously evaluates and pre-computes strategy changes

### 4. Routing vs Full Orchestration
- **Bedrock**: routing mode for simple requests, full supervisor for complex
- **Pattern**: not all tasks need the full orchestration pipeline
- **Motiva application**: simple observation tasks (file exists? test passes?) skip gap/score cycle; complex tasks get full loop

### 5. Four-Point Guardrail Callbacks
- **Google ADK**: before_model, after_model, before_tool, after_tool
- **Pattern**: intercept at every transition point, not just pre-execution
- **Motiva application**: EthicsGate currently only pre-execution; add post-execution safety check and pre/post-LLM content filtering

### 6. AgentCard / Capability Discovery
- **A2A Protocol**: JSON capability descriptions for agent discovery
- **Pattern**: agents publish what they can do; orchestrator discovers and selects dynamically
- **Motiva application**: adapters could publish capability cards; Motiva auto-selects the best adapter for each task type

### 7. Golden Dataset Trajectory Evaluation
- **Google ADK**: exact expected tool-call sequences as ground truth
- **Pattern**: define "ideal" execution paths, measure drift from ideal
- **Motiva application**: for known goal types, define expected observe→task→verify trajectories and score execution quality against them

### 8. Merkle Tree Change Detection
- **Cursor**: hash-based detection of file changes, sync only diffs
- **Pattern**: efficient detection of what actually changed between observations
- **Motiva application**: hash workspace state, only re-observe dimensions where underlying files/data changed

### 9. One-Action-Per-Iteration with Mandatory Observation
- **Manus**: execute one action, observe result, then decide next action
- **Pattern**: prevent runaway multi-step execution; force verification after each step
- **Motiva application**: within task execution, force observation checkpoints instead of "fire and forget" adapter calls

### 10. Tiered Model Strategy
- **Claude Code**: Opus for complex reasoning, Sonnet for focused tasks
- **Manus**: Claude 3.5 for primary reasoning, Qwen for task-specific
- **Pattern**: use expensive models only where they matter
- **Motiva application**: Motiva already supports provider.json; could auto-select model tier per operation type (negotiation=expensive, observation=cheap)

---

## Priority Recommendations for Motiva

### High Priority (directly addresses known gaps)
1. **Four-point guardrail callbacks** — extends EthicsGate beyond pre-execution
2. **Tiered model selection** — auto-select model quality per operation type
3. **Merkle/hash-based observation optimization** — skip unchanged dimensions
4. **Self-verification via different method** — L2 uses different verification approach than L1

### Medium Priority (architectural improvements)
5. **Routing mode for simple tasks** — fast-path that skips full orchestration
6. **AgentCard for adapter discovery** — dynamic adapter selection
7. **Per-goal scratchpad** — file-based working memory for task-level context
8. **Background strategy refinement** — dual-track planning

### Future Consideration (significant architecture change)
9. **Configurable orchestration patterns** (sequential/concurrent/handoff/group)
10. **A2A protocol support** — interop with external agent ecosystems
11. **Golden dataset evaluation** — regression testing for agent execution quality
12. **CodeAct paradigm** — code generation as action mechanism instead of fixed adapters
