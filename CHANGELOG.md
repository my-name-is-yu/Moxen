# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] - 2026-03-21

Phase 3 development infrastructure, OSS optimization (#112-#146, 35 items), hierarchical memory Phase 2, and Node.js 18 end-of-life drop. Test suite: 4315 tests, 196 test files.

### Added

- Added hierarchical memory Phase 2: three-tier storage (core / recall / archival), LLM-driven page-in/out, cross-tier promotion and demotion, dynamic context budgeting, and archival semantic search.
- Added Browser Use CLI adapter for browser-automation task delegation.
- Added A2A protocol adapter for agent interoperability.
- Added structured Reflexion-style reflection with task-lifecycle split.
- Added 4-point guardrail callbacks (before/after execution and before/after LLM call).
- Added LLM fault-tolerance guards (10 guards across 6 modules) covering enum sanitization, direction-check on `dimension_updates`, and Zod validation of `autoDetectDependencies` responses.
- Added custom Error class hierarchy for better error classification and stack filtering (closes #123).
- Added LLM provider enhancements with an `ensure-api-key` CLI helper for interactive key setup.
- Added `SECURITY.md`, competitor comparison table, and OSS-quality README badges.
- Added hypothesis verification mechanism (Milestone 14 follow-up).
- Added convergence detection to `SatisficingJudge`.
- Added consolidated reward-computation JSON log and completion-judger timeout/retry config.

### Changed

- Dropped Node.js 18 support (EOL April 2025); minimum runtime is now Node.js 20.
- Phase 3 file-splitting: 11 large files (700–1400 lines) split into 30+ focused modules; all modules are now under 500 lines.
- Migrated all synchronous `fs.*` calls to `fs/promises` across 28+ modules for consistent async I/O.
- Centralized environment-variable references to `provider-config.ts` and JSON I/O to `json-io.ts` (closes #120, #125).
- Replaced Markdown regex re-parsing with structured metadata in `ReportingEngine` (closes #142).
- Extracted `BaseLLMClient` with shared `safeParse` logic from four LLM clients (closes #112, #119).
- Skipped retry on 4xx client errors in `LLMClient` to avoid wasting quota on permanent failures (closes #134).
- Translated plugin-loader error messages to English (closes #143).
- Reorganized `src/` root (48 files) into 9 subdirectories; 45 files relocated.
- Test suite run time reduced from ~565 s to ~8 s through async-mock fixes and slow-test elimination.
- `docs/status.md` translated to English for OSS readability.

### Fixed

- Fixed Critical OSS issues: URL inconsistency across docs (#159), remaining Node.js 18 references (#160), duplicate Node.js 18 CI matrix entries (#161), and missing `.gitignore` entries for generated artifacts (#166).
- Fixed path traversal vulnerability in `StateManager.readRaw/writeRaw` (closes #126).
- Fixed shell-binary denylist enforcement in `ShellDataSourceAdapter` argv[0] (closes #145).
- Fixed sensitive-directory denylist in `workspace-context` to prevent credential leakage (closes #140).
- Fixed goalId sanitization in `DaemonRunner.generateCronEntry` (closes #146).
- Fixed `execFileSync` replaced with async `execFile` in observation-llm to avoid blocking the event loop (closes #130).
- Fixed infinite stream-reopen loop in Logger (closes #139).
- Fixed `activateMultiple` partial mutation on validation failure (closes #141).
- Fixed broken `addEdge` call in goal-dependency graph so cycle detection works correctly (closes #129).
- Fixed `mkdtempSync` replaced with async `mkdtemp` in `CodexLLMClient` (closes #144).
- Fixed unawaited `saveReport` call in `ReportingEngine.generateNotification` (closes #128).
- Fixed unawaited `recordRebalance` in `PortfolioManager` early-return path (closes #127).
- Fixed `TrustManager` wiring in core-loop reward logging (closes #115).
- Fixed silent error swallowing in 6 core-loop catch blocks and 3 other modules with proper Logger calls (closes #116, #117, #132).
- Fixed strategy ranking to use the correct `hypothesis` key in `StrategyManagerBase` (closes #131).
- Fixed `ENOTEMPTY` race condition in `TreeLoopOrchestrator` cleanup on test teardown.
- Fixed `node:crypto` import for Node.js compatibility in test files.

### Removed

- Removed duplicate wildcard re-exports from `index.ts` (closes #118).
- Removed redundant `observeForTask` duplicate; delegated to `_observeForTask` (closes #136).
- Removed redundant embedding call in `StrategyTemplateRegistry` (closes #137).
- Removed unused `goalDescription` parameter from `matchPluginsForGoal` (closes #121).

## [0.3.0] - 2026-03-16

Milestone 7 delivery: recursive Goal Tree phase 2, cross-goal portfolio phase 2, and learning pipeline phase 2. 163 new tests (3105 → 3268, 89 test files).

### Added

- Added concreteness scoring (`scoreConcreteness()`) with LLM-based 4-dimension evaluation and auto-stop decomposition when the concreteness threshold is reached, plus maxDepth enforcement (default: 5).
- Added decomposition quality metrics (`evaluateDecompositionQuality()`) covering coverage, overlap, actionability, and depth efficiency, with reason-tracked pruning (`pruneSubgoal()`, `getPruneHistory()`) and auto-reverting restructure.
- Added momentum allocation (`calculateMomentum()`) with velocity and trend detection, dependency scheduling via topological sort and critical path analysis, and stall-triggered resource rebalancing (`rebalanceOnStall()`).
- Added embedding-based template recommendation (`indexTemplates()`, `recommendByEmbedding()`, `recommendHybrid()`) combining tag scoring and vector similarity for strategy selection.
- Added 4-step structural feedback recording (`recordStructuralFeedback()`) for observation accuracy, strategy selection, scope sizing, and task generation, with feedback aggregation and parameter auto-tuning suggestions.
- Added cross-goal pattern sharing (`extractCrossGoalPatterns()`, `sharePatternsAcrossGoals()`) with persistent storage and retrieval in KnowledgeTransfer.

## [0.2.0] - 2026-03-16

Latest release covering the last five commits, including Milestone 4 and 5 delivery, dogfooding-driven fixes, expanded documentation, and broader end-to-end validation.

### Added

- Added persistent runtime phase 2 capabilities, including graceful daemon shutdown, interrupted goal state restoration, date-based log rotation, and event-driven loop wakeups.
- Added semantic embedding phase 2 support with a shared knowledge base, vector search for implicit knowledge reuse, Drive-based memory management, semantic working-memory selection, and dynamic context budgeting.
- Added SMTP email delivery via `nodemailer` in place of the previous stub implementation.
- Added new end-to-end coverage for daemon lifecycle behavior, semantic memory flows, shared knowledge retrieval, and multi-goal integration scenarios.
- Added new contributor guidance in `CONTRIBUTING.md` generated through dogfooding.

### Changed

- Improved autonomous iteration behavior during dogfooding by tuning model temperature and lowering auto-progress sensitivity to better detect meaningful context changes.
- Improved progress stability with monotonic scoring controls that prevent score backsliding during repeated evaluations.
- Improved changelog and contributing documentation quality through self-hosted validation runs.

### Fixed

- Fixed overly aggressive file existence auto-registration by guarding it for non-`FileExistence` dimensions.
- Fixed progress oscillation during iterative evaluation by enforcing a minimum threshold for score regression handling.
- Fixed daemon runtime reliability issues around shutdown handling, restoration flow, and interruptible background waiting.

## [0.1.0] - 2026-03-23

### Initial Release

First public release of Motiva — an AI agent orchestrator that gives existing agents autonomous motivation. Motiva sits above agents, selecting goals, spawning sessions, observing results, and judging completion. Motiva delegates all execution; it does not act directly.

### Added

#### Core Loop and Goal Model

- Added the core orchestration loop: observe → gap → score → task → execute → verify, running autonomously until satisficing completion.
- Added the 4-element goal model: Goal (with measurable thresholds), Current State (observation + confidence), Gap, and Constraints.
- Added goal negotiation with feasibility evaluation, dimension decomposition, and counter-proposal handling.
- Added recursive goal tree for sub-goal management with concreteness scoring, decomposition quality metrics, and maxDepth enforcement.
- Added satisficing completion judgment: execution stops when the goal is "good enough" rather than continuing toward perfection.
- Added convergence detection in `SatisficingJudge` to prevent infinite iteration on plateau states.

#### Observation and Verification

- Added 3-layer observation pipeline: mechanical checks (shell/file) → LLM-powered review → self-report fallback.
- Added 3-layer verification pipeline: mechanical checks → LLM reviewer → self-report fallback.
- Added `ShellDataSourceAdapter` and `FileExistenceDataSourceAdapter` for evidence-based observation.
- Added cross-validation across observation layers to improve confidence scoring.
- Added hypothesis verification mechanism for strategy assessment.

#### Drive, Scoring, and Trust

- Added drive scoring with three components: dissatisfaction (gap magnitude), deadline urgency, and opportunity cost.
- Added asymmetric trust system: success adds +3, failure subtracts -10, bounded to [-100, +100].
- Added stall detection with graduated responses (warn → escalate → abort strategy).
- Added monotonic progress controls that prevent score backsliding during repeated evaluations.

#### Safety and Ethics

- Added 2-stage ethics gate for goal screening before execution begins.
- Added path traversal protection in `StateManager.readRaw` / `writeRaw`.
- Added shell-binary denylist enforcement in `ShellDataSourceAdapter`.
- Added sensitive-directory denylist in workspace context to prevent credential leakage.

#### Strategy and Portfolio

- Added strategy management with portfolio optimization across concurrent goals.
- Added momentum allocation with velocity and trend detection, topological dependency scheduling, and stall-triggered rebalancing.
- Added embedding-based strategy template recommendation combining tag scoring and vector similarity.
- Added cross-goal pattern sharing with persistent storage in `KnowledgeTransfer`.

#### Adapters

- Added `claude_code_cli` adapter for Claude Code CLI agent delegation.
- Added `openai_codex_cli` adapter for OpenAI Codex CLI agent delegation.
- Added `browser_use_cli` adapter for browser-automation task delegation.
- Added `claude_api` adapter for direct Anthropic API calls.
- Added `github_issue` adapter for GitHub REST API integration.
- Added `a2a` adapter for Agent-to-Agent protocol interoperability.

#### CLI

- Added `goal add`, `goal list`, and `goal archive` commands.
- Added `run` command to start the autonomous core loop.
- Added `status` and `report` commands for runtime inspection.
- Added `cleanup` command to remove stale state files.
- Added `datasource add`, `datasource list`, and `datasource remove` commands.
- Added `improve` command for LLM-powered goal suggestion.
- Added `--yes` flag (position-independent) to skip confirmation prompts in all flows.
- Added `ensure-api-key` CLI helper for interactive provider key setup.

#### Infrastructure

- Added plugin architecture for external integrations, loaded dynamically from `~/.motiva/plugins/`.
- Added TUI dashboard built with Ink/React, including approval UI and chat interface.
- Added Web UI built with Next.js, covering Goals, Sessions, Knowledge, and Settings pages.
- Added daemon mode with PID management, graceful shutdown, and interrupted goal state restoration.
- Added event server with HTTP and file-queue (`~/.motiva/events/`) ingestion modes.
- Added notification dispatcher with SMTP email delivery via `nodemailer`.
- Added date-based log rotation with async stream management.

#### Knowledge and Memory

- Added semantic knowledge base with `IEmbeddingClient` abstraction (OpenAI / Ollama / Mock backends).
- Added `VectorIndex` with hand-implemented cosine similarity search (no external dependencies).
- Added knowledge graph and goal dependency graph with cycle detection.
- Added learning pipeline with 4-step structural feedback recording and parameter auto-tuning suggestions.
- Added knowledge transfer with cross-goal pattern extraction and sharing.
- Added hierarchical memory with three-tier storage (core / recall / archival), LLM-driven page-in/page-out, and dynamic context budgeting.

#### Character and Curiosity

- Added curiosity engine for autonomous exploration of underobserved goal dimensions.
- Added character configuration manager for personality and ethics profile customization.
- Added Reflexion-style reflection with task-lifecycle split for iterative self-improvement.

#### Developer Experience

- Added custom Error class hierarchy for error classification and stack filtering.
- Added 4-point guardrail callbacks (before/after execution, before/after LLM call) for observability.
- Added LLM fault-tolerance guards covering enum sanitization, direction-check on `dimension_updates`, and Zod validation across 6 modules.
- Added npm publishing metadata including `exports`, license, author fields, and `.npmignore`.
- Added `SECURITY.md`, `CONTRIBUTING.md`, competitor comparison table, and OSS-quality README badges.
- Test suite: 4315 tests across 196 test files.
