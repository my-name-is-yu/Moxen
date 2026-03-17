# モジュール境界マップ

> このドキュメントはClaude Codeが「どのファイルを触るべきか」を即判断するためのガイド。
> 変更の種類に応じて、対象ファイルを素早く特定できる。

## クイックリファレンス: 変更種類 → 対象ファイル

| 変更したいこと | 主要ファイル | テストファイル |
|---|---|---|
| ゴール交渉・分解ロジック | src/goal/goal-negotiator.ts | tests/goal-negotiator.test.ts |
| ゴール自動提案・フィルタ | src/goal/goal-suggest.ts | tests/goal-negotiator-suggest.test.ts, tests/goal-negotiator-suggest-filter.test.ts |
| ゴールバリデーション・次元変換 | src/goal/goal-validation.ts | tests/goal-tree-quality.test.ts |
| ゴールツリー操作・品質評価 | src/goal/goal-tree-manager.ts | tests/goal-tree-manager.test.ts, tests/goal-tree-quality.test.ts, tests/goal-tree-concreteness.test.ts |
| ゴール依存グラフ | src/goal/goal-dependency-graph.ts | tests/goal-dependency-graph.test.ts, tests/capability-dependency.test.ts |
| ゴール横断状態集約 | src/goal/state-aggregator.ts | tests/state-aggregator.test.ts |
| ゴールツリーループ実行 | src/goal/tree-loop-orchestrator.ts | tests/tree-loop-orchestrator.test.ts |
| ギャップ計算（5閾値型） | src/drive/gap-calculator.ts | tests/gap-calculator.test.ts |
| モチベーションスコアリング | src/drive/drive-scorer.ts | tests/drive-scorer.test.ts |
| モチベーション駆動システム | src/drive/drive-system.ts | tests/drive-system.test.ts |
| ストール検出 | src/drive/stall-detector.ts | tests/stall-detector.test.ts |
| 満足化判定 | src/drive/satisficing-judge.ts | tests/satisficing-judge.test.ts, tests/satisficing-judge-undershoot.test.ts |
| タスク実行ライフサイクル | src/execution/task-lifecycle.ts | tests/task-lifecycle.test.ts, tests/task-lifecycle-healthcheck.test.ts |
| タスクプロンプト生成 | src/execution/task-prompt-builder.ts | tests/task-lifecycle.test.ts |
| タスクヘルスチェック | src/execution/task-health-check.ts | tests/task-lifecycle-healthcheck.test.ts |
| アダプタ抽象層・レジストリ | src/execution/adapter-layer.ts | tests/adapter-layer.test.ts |
| セッション・コンテキスト管理 | src/execution/session-manager.ts | tests/session-manager.test.ts, tests/session-manager-phase2.test.ts |
| 観測エンジン | src/observation/observation-engine.ts | tests/observation-engine.test.ts, tests/observation-engine-llm.test.ts, tests/observation-engine-context.test.ts, tests/observation-engine-dedup.test.ts, tests/observation-engine-crossvalidation.test.ts, tests/observation-engine-prompt.test.ts |
| データソースアダプタ基盤 | src/observation/data-source-adapter.ts | tests/data-source-adapter.test.ts, tests/data-source-hotplug.test.ts |
| 能力検出・獲得 | src/observation/capability-detector.ts | tests/capability-detector.test.ts, tests/cli-capability.test.ts |
| コンテキストプロバイダ | src/observation/context-provider.ts | tests/context-provider.test.ts |
| ワークスペースコンテキスト | src/observation/workspace-context.ts | tests/workspace-context.test.ts |
| LLMクライアント抽象層 | src/llm/llm-client.ts | tests/llm-client.test.ts |
| Anthropic Claudeクライアント | src/llm/llm-client.ts (LLMClient) | tests/llm-client.test.ts |
| OpenAIクライアント | src/llm/openai-client.ts | tests/openai-client.test.ts |
| Ollamaクライアント | src/llm/ollama-client.ts | tests/ollama-client.test.ts |
| Codex CLIクライアント | src/llm/codex-llm-client.ts | tests/codex-llm-client.test.ts |
| プロバイダ設定・切替 | src/llm/provider-config.ts, src/llm/provider-factory.ts | tests/provider-factory.test.ts |
| 戦略選択・管理 | src/strategy/strategy-manager.ts | tests/strategy-manager.test.ts |
| 戦略テンプレート登録 | src/strategy/strategy-template-registry.ts | tests/strategy-template-registry.test.ts, tests/strategy-template-embedding.test.ts |
| ゴール横断ポートフォリオ | src/strategy/cross-goal-portfolio.ts | tests/cross-goal-portfolio.test.ts, tests/cross-goal-portfolio-phase2.test.ts |
| ポートフォリオマネージャ | src/portfolio-manager.ts | tests/portfolio-manager.test.ts |
| メモリライフサイクル | src/knowledge/memory-lifecycle.ts | tests/memory-lifecycle.test.ts, tests/memory-lifecycle-phase2.test.ts |
| メモリ永続化ユーティリティ | src/knowledge/memory-persistence.ts | (memory-lifecycle.test.ts 経由) |
| メモリフェーズ操作（インデックス等） | src/knowledge/memory-phases.ts | (memory-lifecycle.test.ts 経由) |
| DriveScoreアダプタ | src/knowledge/drive-score-adapter.ts | tests/drive-score-adapter.test.ts |
| 知識管理 | src/knowledge/knowledge-manager.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| 知識グラフ | src/knowledge/knowledge-graph.ts | tests/knowledge-graph.test.ts |
| 知識転送 | src/knowledge/knowledge-transfer.ts | tests/knowledge-transfer.test.ts |
| 学習パイプライン | src/knowledge/learning-pipeline.ts | tests/learning-pipeline.test.ts, tests/learning-pipeline-phase2.test.ts, tests/learning-cross-goal.test.ts |
| 埋め込みクライアント | src/knowledge/embedding-client.ts | tests/embedding-client.test.ts |
| ベクトルインデックス | src/knowledge/vector-index.ts | tests/vector-index.test.ts |
| 倫理ゲート | src/traits/ethics-gate.ts | tests/ethics-gate.test.ts |
| 信頼マネージャ | src/traits/trust-manager.ts | tests/trust-manager.test.ts |
| キャラクター設定 | src/traits/character-config.ts | tests/character-config.test.ts, tests/character-separation.test.ts |
| 好奇心エンジン | src/traits/curiosity-engine.ts | tests/curiosity-engine.test.ts |
| デーモン実行管理 | src/runtime/daemon-runner.ts | tests/daemon-runner.test.ts |
| プロセスID管理 | src/runtime/pid-manager.ts | tests/pid-manager.test.ts |
| ロガー | src/runtime/logger.ts | tests/logger.test.ts |
| イベントサーバ | src/runtime/event-server.ts | tests/event-server.test.ts |
| 通知ディスパッチャ | src/runtime/notification-dispatcher.ts | tests/notification-dispatcher.test.ts |
| Claudeアダプタ（CLI） | src/adapters/claude-code-cli.ts | tests/claude-code-cli-adapter.test.ts |
| Claudeアダプタ（API） | src/adapters/claude-api.ts | (adapter-layer.test.ts 経由) |
| OpenAI Codex CLIアダプタ | src/adapters/openai-codex.ts | tests/openai-codex-adapter.test.ts |
| GitHub Issueアダプタ | src/adapters/github-issue.ts | tests/github-issue-adapter.test.ts |
| GitHub Issue データソース | src/adapters/github-issue-datasource.ts | tests/github-issue-datasource.test.ts |
| ファイル存在データソース | src/adapters/file-existence-datasource.ts | tests/file-existence-datasource.test.ts |
| シェルデータソース | src/adapters/shell-datasource.ts | tests/adapters/shell-datasource.test.ts |
| コアループ | src/core-loop.ts | tests/core-loop.test.ts, tests/core-loop-integration.test.ts, tests/core-loop-capability.test.ts, tests/r1-core-loop-completion.test.ts |
| レポーティング | src/reporting-engine.ts | tests/reporting-engine.test.ts |
| 状態管理（永続化） | src/state-manager.ts | tests/state-manager.test.ts |
| CLIエントリポイント | src/cli-runner.ts | tests/cli-runner.test.ts, tests/cli-runner-integration.test.ts, tests/cli-runner-datasource-auto.test.ts |
| CLIコマンド（ゴール） | src/cli/commands/goal.ts | tests/cli-runner.test.ts |
| CLIコマンド（提案・improve） | src/cli/commands/suggest.ts | tests/cli-improve.test.ts, tests/suggest-output-schema.test.ts |
| CLIコマンド（設定） | src/cli/commands/config.ts | tests/cli-runner.test.ts |
| CLIセットアップ・DI | src/cli/setup.ts | tests/cli-runner.test.ts |
| TUIアプリ本体 | src/tui/app.tsx | tests/tui/ |
| TUIループフック | src/tui/use-loop.ts | tests/tui/use-loop.test.ts |
| TUIインテント認識 | src/tui/intent-recognizer.ts | tests/tui/intent-recognizer.test.ts |

---

## ディレクトリ別モジュール詳細

### src/goal/ — ゴール管理

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| goal-negotiator.ts | ゴール交渉・整合確認・能力チェック | `GoalNegotiator`, `EthicsRejectedError` | llm/llm-client, traits/ethics-gate, observation/observation-engine, observation/capability-detector, goal/goal-suggest, goal/goal-validation, state-manager, types/goal |
| goal-suggest.ts | ゴール自動提案プロンプト・スキーマ | `GoalSuggestion`, `buildSuggestGoalsPrompt`, `buildCapabilityCheckPrompt`, `CapabilityCheckResultSchema` | types/suggest |
| goal-validation.ts | 次元変換・閾値構築・dedup・マッチング | `decompositionToDimension`, `buildThreshold`, `deduplicateDimensionKeys`, `findBestDimensionMatch` | types/goal |
| goal-tree-manager.ts | ゴールツリー操作・品質評価・刈り込み | `GoalTreeManager`, `GoalTreeManagerOptions` | state-manager, llm/llm-client, traits/ethics-gate, goal/goal-dependency-graph, goal/goal-negotiator, types/goal, types/goal-tree |
| goal-dependency-graph.ts | ゴール間の依存関係グラフ管理 | `GoalDependencyGraph` | types/dependency |
| state-aggregator.ts | ゴールツリー全体の状態集約 | `StateAggregator`, `AggregatedState` | state-manager, types/goal, types/goal-tree |
| tree-loop-orchestrator.ts | ゴールツリー全体のループ実行 | `TreeLoopOrchestrator` | state-manager, goal/goal-tree-manager, goal/state-aggregator, execution/task-lifecycle, drive/satisficing-judge, types/goal-tree |

### src/drive/ — モチベーション計算

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| gap-calculator.ts | 5閾値型ギャップ計算・正規化・集約 | `computeRawGap`, `normalizeGap`, `applyConfidenceWeight`, `calculateDimensionGap`, `calculateGapVector`, `aggregateGaps`, `DimensionGapInput` | types/gap, types/core |
| drive-scorer.ts | 不満足度・締め切り・機会スコア計算 | `scoreDissatisfaction`, `scoreDeadline`, `scoreOpportunity`, `computeOpportunityValue`, `combineDriveScores`, `scoreAllDimensions`, `rankDimensions` | types/drive, types/gap |
| drive-system.ts | ドライブスコアの統合管理 | `DriveSystem` | drive/gap-calculator, drive/drive-scorer, types/drive, types/core |
| stall-detector.ts | 進捗停滞の検出 | `StallDetector` | types/stall, types/state |
| satisficing-judge.ts | 満足化判定・resource undershoot | `SatisficingJudge`, `aggregateValues` | types/satisficing, types/goal, types/goal-tree |

### src/execution/ — タスク実行

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| adapter-layer.ts | アダプタ抽象インタフェース・レジストリ | `AgentTask`, `AgentResult`, `IAdapter`, `AdapterRegistry` | types/task |
| session-manager.ts | コンテキスト予算管理・セッション構築 | `SessionManager`, `ContextBudget`, `DEFAULT_CONTEXT_BUDGET` | state-manager, knowledge/knowledge-manager, types/session |
| task-lifecycle.ts | タスク全ライフサイクル（生成→実行→検証） | `TaskLifecycle`, `ExecutorReport`, `TaskCycleResult`, `VerdictResult`, `FailureResult` | state-manager, llm/llm-client, execution/session-manager, traits/trust-manager, strategy/strategy-manager, drive/stall-detector, drive/drive-scorer, execution/task-prompt-builder, execution/task-health-check, traits/ethics-gate, observation/capability-detector, types/task |
| task-prompt-builder.ts | タスク生成プロンプトの構築 | `buildTaskGenerationPrompt` | types/task, types/drive, types/gap |
| task-health-check.ts | タスク実行後ヘルスチェック | `runShellCommand` (内部利用) | (Node.js child_process) |

### src/observation/ — 観測

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| observation-engine.ts | 状態観測・LLMレビュー・クロス検証 | `ObservationEngine`, `ObservationEngineOptions`, `CrossValidationResult` | state-manager, llm/llm-client, observation/data-source-adapter, types/state, types/core, types/knowledge |
| data-source-adapter.ts | データソース抽象層・ファイル/HTTPアダプタ・レジストリ | `IDataSourceAdapter`, `FileDataSourceAdapter`, `HttpApiDataSourceAdapter`, `DataSourceRegistry`, `getNestedValue` | types/data-source |
| capability-detector.ts | 能力検出・自律獲得計画・検証 | `CapabilityDetector` | state-manager, llm/llm-client, types/capability |
| context-provider.ts | ワークスペースコンテキスト収集 | `dimensionNameToSearchTerms` (+ 内部`buildWorkspaceContext`) | (Node.js fs, child_process) |
| workspace-context.ts | ワークスペースコンテキストプロバイダファクトリ | `WorkspaceContextOptions`, `createWorkspaceContextProvider` | (Node.js fs, child_process) |

### src/llm/ — LLMクライアント

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| llm-client.ts | LLMインタフェース定義・Anthropic実装・Mock | `ILLMClient`, `LLMClient`, `MockLLMClient`, `LLMMessage`, `LLMRequestOptions`, `LLMResponse`, `extractJSON` | @anthropic-ai/sdk |
| openai-client.ts | OpenAI API実装 | `OpenAILLMClient`, `OpenAIClientConfig` | openai SDK |
| ollama-client.ts | Ollama ローカルLLM実装 | `OllamaLLMClient`, `OllamaClientConfig` | node:http |
| codex-llm-client.ts | OpenAI Codex CLI経由LLM実装 | `CodexLLMClient`, `CodexLLMClientConfig` | node:child_process |
| provider-config.ts | プロバイダ設定ファイル読み書き | `ProviderConfig`, `loadProviderConfig`, `saveProviderConfig` | node:fs |
| provider-factory.ts | LLMクライアント・アダプタレジストリのDIファクトリ | `buildLLMClient`, `buildAdapterRegistry` | llm/provider-config, llm/llm-client, llm/openai-client, llm/ollama-client, llm/codex-llm-client, adapters/* |

### src/strategy/ — 戦略管理

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| strategy-manager.ts | 戦略選択・アクティブ化・更新 | `StrategyManager` | state-manager, llm/llm-client, types/strategy, types/knowledge |
| strategy-template-registry.ts | 戦略テンプレートの登録・埋め込み検索 | `StrategyTemplateRegistry` | knowledge/embedding-client, knowledge/vector-index, types/strategy |
| cross-goal-portfolio.ts | ゴール横断リソース配分・スケジューリング | `CrossGoalPortfolio` | state-manager, types/cross-portfolio, types/goal |

### src/knowledge/ — 知識・メモリ管理

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| memory-lifecycle.ts | メモリライフサイクル全体管理（短期/長期/圧縮） | `MemoryLifecycleManager`, `IDriveScorer` (re-export) | llm/llm-client, knowledge/embedding-client, knowledge/vector-index, knowledge/drive-score-adapter, knowledge/memory-phases, knowledge/memory-persistence |
| memory-phases.ts | メモリインデックス操作・統計・クエリ・蒸留 | `initializeIndex`, `loadIndex`, `saveIndex`, `updateIndex`, `storeLessonsLongTerm`, `updateStatistics`, `queryLessons`, `queryCrossGoalLessons`, `validateCompressionQuality` 等 | types/memory-lifecycle |
| memory-persistence.ts | ファイルI/O・atomic write・IDジェネレータ | `atomicWrite`, `readJsonFile`, `getDataFile`, `generateId`, `getDirectorySize`, `getRetentionLimit` | node:fs |
| drive-score-adapter.ts | DriveScoreをMemoryLifecycleへ接続するアダプタ | `IDriveScorer`, `DriveScoreAdapter` | drive/drive-scorer, types/drive |
| knowledge-manager.ts | 知識の保存・検索・再検証 | `KnowledgeManager` | state-manager, llm/llm-client, knowledge/vector-index, knowledge/embedding-client, types/knowledge, types/task |
| knowledge-graph.ts | ゴール/タスク/知識間のグラフ構造管理 | `KnowledgeGraph` | types/knowledge |
| knowledge-transfer.ts | ゴール間知識転送・類似ゴール検索 | `KnowledgeTransfer` | knowledge/embedding-client, knowledge/vector-index, types/knowledge, types/learning |
| learning-pipeline.ts | 実行結果から教訓抽出・クロスゴール学習 | `LearningPipeline` | llm/llm-client, knowledge/memory-lifecycle, knowledge/knowledge-transfer, types/learning |
| embedding-client.ts | 埋め込みベクトル生成インタフェース | `IEmbeddingClient`, `MockEmbeddingClient`, `OllamaEmbeddingClient`, `OpenAIEmbeddingClient`, `cosineSimilarity` | openai SDK, node:http |
| vector-index.ts | cosine similarityによるベクトル近傍検索 | `VectorIndex` | knowledge/embedding-client |

### src/traits/ — キャラクター・倫理・信頼

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| ethics-gate.ts | タスク倫理審査・ブロック判定（destructive/credential/integrity/privacy） | `EthicsGate` | llm/llm-client, types/ethics, types/task |
| trust-manager.ts | エージェント信頼スコア管理（[-100,+100]） | `TrustManager` | state-manager, types/trust |
| character-config.ts | エージェントキャラクター設定の読み書き | `CharacterConfigManager` | state-manager, types/character |
| curiosity-engine.ts | 新規ゴール提案・探索的観測 | `CuriosityEngine`, `CuriosityEngineDeps` | llm/llm-client, observation/observation-engine, types/curiosity |

### src/runtime/ — プロセス管理・I/O

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| logger.ts | 構造化ログ出力（debug/info/warn/error） | `Logger`, `LogLevel`, `LoggerConfig` | node:fs |
| pid-manager.ts | デーモンPIDファイル管理 | `PIDManager` | node:fs |
| daemon-runner.ts | デーモン起動・停止・再起動管理 | `DaemonRunner`, `DaemonDeps` | runtime/pid-manager, runtime/logger, runtime/event-server, types/daemon |
| event-server.ts | ファイルキューベースイベント受信 | `EventServer`, `EventServerConfig` | node:fs |
| notification-dispatcher.ts | 通知送信（stdout/ファイル/webhook） | `NotificationDispatcher`, `INotificationDispatcher` | runtime/logger, types/notification |

### src/adapters/ — エージェントアダプタ実装

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| claude-code-cli.ts | Claude Code CLI経由でタスク実行 | `ClaudeCodeCLIAdapter` (IAdapter) | execution/adapter-layer, types/task |
| claude-api.ts | Anthropic API経由でタスク実行 | `ClaudeAPIAdapter` (IAdapter) | execution/adapter-layer, llm/llm-client |
| openai-codex.ts | OpenAI Codex CLI経由でタスク実行 | `OpenAICodexCLIAdapter`, `OpenAICodexCLIAdapterConfig` | execution/adapter-layer |
| github-issue.ts | GitHub Issue作成・管理アダプタ | `GitHubIssueAdapter`, `GitHubIssueAdapterConfig`, `ParsedIssue` | execution/adapter-layer |
| github-issue-datasource.ts | GitHub Issue状態の観測データソース | `GitHubIssueDataSourceAdapter` (IDataSourceAdapter) | observation/data-source-adapter, types/data-source |
| file-existence-datasource.ts | ファイル存在を観測するデータソース | `FileExistenceDataSourceAdapter` (IDataSourceAdapter) | observation/data-source-adapter, types/data-source |
| shell-datasource.ts | シェルコマンド出力を観測するデータソース | `ShellDataSourceAdapter`, `ShellCommandSpec` | observation/data-source-adapter, types/data-source |

### src/ — ルートモジュール（統合レイヤー）

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| core-loop.ts | メインオーケストレーションループ | `CoreLoop`, `LoopConfig`, `LoopResult`, `CoreLoopDeps`, `buildDriveContext` | 全モジュール（DI注入） |
| state-manager.ts | ゴール・状態・ログのファイルベースJSON永続化 | `StateManager` | node:fs, types/goal, types/state |
| reporting-engine.ts | 実行サマリ・通知生成 | `ReportingEngine` | runtime/notification-dispatcher, types/report |
| portfolio-manager.ts | 並列ポートフォリオ戦略管理 | `PortfolioManager` | state-manager, drive/drive-scorer, execution/task-lifecycle, strategy/cross-goal-portfolio, types/portfolio |
| index.ts | ライブラリパブリックAPI（npm publish用） | (全主要クラス re-export) | 全モジュール |
| cli-runner.ts | CLIエントリポイント・コマンドルーティング | (デフォルトエクスポートなし、main関数) | cli/setup, cli/commands/*, state-manager |

### src/cli/ — CLIコマンド実装

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| setup.ts | 全依存関係のDI組み立て | `buildDeps` | 全モジュール（DI組立） |
| utils.ts | CLIヘルパー・使用法表示 | `formatOperationError`, `printUsage`, `printCharacterConfig` | (なし) |
| commands/run.ts | `motiva run` コマンド実装 | `buildApprovalFn` | core-loop, state-manager |
| commands/goal.ts | `motiva goal *` コマンド群 | `cmdGoalList`, `cmdStatus`, `cmdGoalShow`, `cmdGoalReset`, `cmdLog`, `cmdCleanup`, `autoRegisterFileExistenceDataSources` | state-manager, observation/data-source-adapter, adapters/file-existence-datasource |
| commands/report.ts | `motiva report` コマンド | `cmdReport` | state-manager, reporting-engine |
| commands/suggest.ts | `motiva suggest` / `motiva improve` コマンド | `normalizeSuggestPayload` | goal/goal-negotiator, observation/capability-detector, state-manager |
| commands/config.ts | `motiva provider` / `motiva character` / `motiva datasource` | `maskSecrets`, `cmdProvider`, `cmdConfigCharacter`, `cmdDatasourceList`, `cmdDatasourceRemove` | llm/provider-config, traits/character-config, state-manager |
| commands/daemon.ts | `motiva daemon start/stop/status` コマンド | (内部実装) | runtime/daemon-runner, runtime/pid-manager |

### src/tui/ — TUIダッシュボード（Ink/React）

| ファイル | 責務 | 主要export | 依存先 |
|---|---|---|---|
| entry.ts | TUI起動エントリポイント | (メイン関数) | tui/app, core-loop |
| app.tsx | TUIアプリ本体・状態管理 | `App`, `ApprovalRequest` | tui/dashboard, tui/chat, tui/use-loop, tui/actions, tui/approval-overlay |
| use-loop.ts | コアループとのReact統合フック | `useLoop`, `LoopController`, `LoopState`, `DimensionProgress`, `calcDimensionProgress`, `UseLoopResult` | core-loop |
| intent-recognizer.ts | チャット入力のインテント分類 | `IntentRecognizer`, `IntentType`, `RecognizedIntent` | (なし) |
| actions.ts | TUIアクションハンドラ | `ActionHandler`, `ActionDeps`, `ActionResult` | core-loop, goal/goal-negotiator |
| dashboard.tsx | 状態ダッシュボード表示コンポーネント | `Dashboard` | tui/use-loop |
| chat.tsx | チャットUIコンポーネント | `Chat`, `ChatMessage` | (Ink/React) |
| approval-overlay.tsx | タスク承認オーバーレイ | `ApprovalOverlay` | (Ink/React) |
| help-overlay.tsx | ヘルプオーバーレイ | `HelpOverlay` | (Ink/React) |
| report-view.tsx | レポート表示コンポーネント | `ReportView`, `ReportViewProps` | tui/markdown-renderer |
| markdown-renderer.ts | Markdownテキストレンダリング | `renderMarkdownLines`, `renderMarkdown`, `MarkdownLine` | (なし) |

### src/types/ — 型定義（Zodスキーマ）

| ファイル | 主な型 |
|---|---|
| types/core.ts | ObservationLayer, ConfidenceTier, StrategyState 等 |
| types/goal.ts | Goal, Dimension, Threshold, GoalSchema |
| types/goal-tree.ts | GoalTreeNode, ConcretenessScore, DecompositionQualityMetrics |
| types/gap.ts | GapVector, DimensionGap |
| types/drive.ts | DriveContext, DriveScore |
| types/task.ts | Task, VerificationResult |
| types/strategy.ts | Strategy, Portfolio, WaitStrategy |
| types/state.ts | ObservationLog, ObservationLogEntry |
| types/session.ts | SessionContext |
| types/trust.ts | TrustScore |
| types/satisficing.ts | SatisficingResult |
| types/stall.ts | StallSignal |
| types/ethics.ts | EthicsVerdict |
| types/knowledge.ts | KnowledgeGapSignal, KnowledgeEntry |
| types/memory-lifecycle.ts | ShortTermEntry, LongTermEntry, MemoryIndex, RetentionConfig |
| types/learning.ts | LessonRecord, LearningResult |
| types/cross-portfolio.ts | TransferCandidate |
| types/capability.ts | CapabilityInfo, CapabilityAcquisitionTask |
| types/data-source.ts | DataSourceConfig, DataSourceQuery |
| types/dependency.ts | GoalDependency |
| types/embedding.ts | EmbeddingVector |
| types/character.ts | CharacterConfig |
| types/curiosity.ts | CuriosityProposal |
| types/notification.ts | NotificationPayload |
| types/daemon.ts | DaemonConfig |
| types/report.ts | ReportEntry |
| types/portfolio.ts | PortfolioState |
| types/negotiation.ts | NegotiationResult |
| types/suggest.ts | SuggestOutput |
| types/index.ts | 全型の再エクスポート |

---

## アーキテクチャ上の注意点

- **CoreLoop は全モジュールをDIで受け取る** — `CoreLoopDeps` を変更すると広範囲に影響
- **IAdapter / IDataSourceAdapter は独立した抽象層** — 新アダプタ追加は `execution/adapter-layer.ts` / `observation/data-source-adapter.ts` のインタフェースを実装するだけでよい
- **ILLMClient も抽象層** — LLMプロバイダの追加/切替は `llm/provider-factory.ts` のみ変更
- **types/ はゼロ依存** — 他のsrcモジュールを import しない。型変更は最も影響範囲が広い
- **memory-phases.ts は memory-lifecycle.ts の内部実装** — 直接インポートすべきでない（memory-lifecycle.ts 経由でアクセス）
