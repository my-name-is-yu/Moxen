# Agent Sessions統合ビュー — 調査結果

調査日: 2026-03-20

---

## 1. 現在のセッションページ (`web/src/app/sessions/page.tsx`)

### 既存機能

- **データソース**: `useMotivaStore` (Zustand) の `sessions` スライスから取得。ストアは `~/.motiva/sessions/*.json` を API 経由でポーリングしている。
- **フィルタバー**: Status (all/active/running/completed/failed/stalled) / Adapter / Role (session_type) の3軸ドロップダウン。フィルタ後件数を表示。
- **セッションテーブル**: 列は Session ID (8文字省略) / Goal / Adapter / Role / Status (dot+badge) / Time (relativeTime)。行クリックで右ペインに詳細を展開。
- **DetailPanel**: ID, goal_name, Type/Adapter/Started/Status のメタ行, パイプラインステージドット可視化 (observe→gap→score→task→execute→verify), result_summary, output (`<pre>`) をスクロール表示。
- **SkeletonTable**: ロード中はスケルトンUI (5行×6列)。
- **ローカル型定義**: `interface Session` はページ内でインライン定義。`src/types/session.ts` の型と乖離がある（後述）。

### 不足している機能 (現状の空白)

- リアルタイム更新なし (ポーリング間隔はストア側に依存)
- 複数セッションの同時比較なし
- ゴール別グルーピング/タイムライン表示なし
- パイプラインステージのアニメーションなし
- セッション間の依存関係・親子関係表示なし
- adapter_type / goal_name はセッションJSONに埋め込まれている前提 (実際の型定義にはない — 後述)

---

## 2. セッションデータモデル (`src/types/session.ts`)

### SessionSchema フィールド

| フィールド | 型 | 説明 |
|-----------|---|------|
| `id` | string | セッションID |
| `session_type` | enum | task_execution / observation / task_review / goal_review |
| `goal_id` | string | 紐づくゴールID |
| `task_id` | string \| null | 紐づくタスクID (null=観測セッション等) |
| `context_slots` | ContextSlot[] | コンテキストスロット配列 |
| `context_budget` | number | 割り当てトークンバジェット |
| `started_at` | string | 開始時刻 (ISO) |
| `ended_at` | string \| null | 終了時刻 (null=進行中) |
| `result_summary` | string \| null | 結果サマリ |

**ページ側の型との乖離**: `adapter_type`, `goal_name`, `current_stage`, `output`, `status`, `created_at` はページの `interface Session` に定義されているが、`SessionSchema` には存在しない。これらはディスクの JSON に実際に書き込まれているか、またはAPIレイヤーが付加しているかを要確認。**Confirmed** なのは SessionSchema の8フィールドのみ。

### 関連型: PipelineState (`src/types/pipeline.ts`)

| フィールド | 型 |
|-----------|---|
| `pipeline_id` | string |
| `task_id` | string |
| `current_stage_index` | number |
| `completed_stages` | StageResult[] |
| `status` | running / completed / failed / interrupted |
| `started_at` | string |
| `updated_at` | string |

セッションとパイプラインは現在別ファイルに永続化。統合ビューには両方のデータを結合する必要がある。

### SessionType enum

```
task_execution | observation | task_review | goal_review
```

### 可能なセッションステータス (ページUI準拠)

```
active | running | completed | failed | stalled
```

---

## 3. SessionManager (`src/execution/session-manager.ts`)

### 主要 API

| メソッド | 説明 |
|---------|------|
| `createSession(...)` | セッション作成、`sessions/<id>.json` に永続化 |
| `endSession(sessionId, resultSummary)` | セッション終了、`ended_at` を記録 |
| `getSession(sessionId)` | 単体セッション取得 |
| `getActiveSessions(goalId)` | ゴールIDで進行中セッション一覧取得 |
| `saveCheckpoint(...)` | エージェント間ハンドオフ用チェックポイント保存 |
| `loadCheckpoint(goalId, currentAgentId, taskId?)` | チェックポイント読み込み |

- 永続化パス: `~/.motiva/sessions/<session_id>.json` (StateManager.writeRaw 経由)
- セッションインデックス: `sessions/index.json` に ID リストを保持
- `getActiveSessions` は `ended_at === null` のセッションをフィルタ
- **チェックポイント機能**: M16で追加。エージェントA→B へのコンテキスト引き継ぎをサポート。CheckpointManager を DI で注入。

---

## 4. マルチエージェント委譲設計 (`docs/design/multi-agent-delegation.md`)

### TaskRole

```
implementor | reviewer | verifier | researcher
```

将来候補: `deployer`, `monitor`, `notifier`

### タスクサイズ別パイプライン

| サイズ | 構成 |
|--------|------|
| Small | implementor のみ |
| Medium | implementor → verifier |
| Large | researcher → implementor(並列) → verifier → reviewer |

### PipelineState (ディスク永続化)

各ステージ完了後に `PipelineState` を StateManager 経由で書き込む。再起動時に `status: "interrupted"` を検出して `current_stage_index` から再開。

### 統合ビューに関係する設計ポイント

- セッション × パイプラインステージの対応が現状不明確。1セッション = 1ステージ実行 なのか、1セッション = 1パイプライン全体なのか設計書には明記なし → **Uncertain**。
- `StageResult` に `role`, `verdict` (pass/partial/fail), `output`, `confidence`, `idempotency_key` が含まれ、統合ビューに表示価値あり。
- 3段階エスカレーション (Strike 1→2→3) の現在状態を可視化すると有用。

---

## 5. ロードマップコンテキスト (`docs/roadmap.md`)

- **M15 (マルチエージェント委譲)**: Status = **done (2026-03-19)**。PipelineExecutor 実装、PipelineState 永続化、冪等性キー、CapabilityDetector 連携が完了済み。
- **M18 (Web UI)**: Status = **done (2026-03-20)**。Sessions ページは M18 の一部として実装済みだが、M15 のパイプライン可視化は未統合と思われる。
- **Agent Sessions統合ビュー**: M18以降の次タスクとして `in-progress.md` に記載。

---

## 6. Web UI 構造 (`web/src/app/`)

### ページ一覧

| パス | 説明 |
|-----|------|
| `/` | トップ (dashboard) |
| `/goals` | ゴール一覧 |
| `/goals/[id]` | ゴール詳細 |
| `/sessions` | セッション一覧 ← 拡張対象 |
| `/knowledge` | 知識ベース |
| `/settings` | 設定 |

### API Routes

| ルート | 説明 |
|--------|------|
| `GET /api/sessions` | `~/.motiva/sessions/*.json` を全読み込み |
| `GET /api/goals` | ゴール一覧 |
| `GET /api/goals/[id]` | ゴール詳細 |
| `GET /api/goals/[id]/tasks` | タスク一覧 |
| `GET /api/goals/[id]/gap-history` | gap履歴 |
| `GET /api/strategies/[goalId]` | 戦略情報 |
| `GET /api/knowledge/search` | 知識検索 |
| `GET /api/knowledge/patterns` | パターン |
| `GET /api/knowledge/transfers` | 転移候補 |
| `GET /api/reports/[goalId]` | レポート |
| `GET /api/events` | SSE (リアルタイム) |
| `GET /api/decisions` | 決定履歴 |
| `GET /api/settings/provider` | プロバイダ設定 |
| `GET /api/settings/plugins` | プラグイン設定 |

---

## 7. ギャップ分析 (統合ビューの要件定義に向けて)

### データ面のギャップ

1. **セッションとパイプラインの結合**: `GET /api/sessions` は SessionSchema JSON のみ返す。PipelineState は別ファイルに保存されており、APIが存在しない。統合表示には `/api/pipelines` または sessions API への join が必要。
2. **adapter_type, goal_name 等の欠落**: ページ側 `interface Session` にあるがスキーマに無い。実際の JSON ファイルに含まれているか未確認。
3. **status フィールドの欠落**: `SessionSchema` に status がない。`ended_at` から導出するか、実際の JSON に追加フィールドがあるか要確認。
4. **PipelineState の API なし**: `~/.motiva/sessions/` とは別のパスに保存されている可能性あり (StateManager の実際のパスを要確認)。

### UI面のギャップ

1. **ゴール別グルーピング**: 現状はフラットリスト。ゴールごとに折りたたみ/展開するグルーピングビューが有用。
2. **パイプラインステージ可視化**: DetailPanel の `PipelineStages` は observe→verify の固定ステージを表示するが、M15 の implementor/reviewer/verifier/researcher ロールへの対応がない。
3. **リアルタイム更新**: `/api/events` (SSE) は存在するが sessions ページで未使用。
4. **タイムライン表示**: 複数セッションの時系列を並べる横型タイムラインが統合ビューとして有効。
5. **StageResult の詳細**: 各ステージの verdict/confidence/side_effects を DetailPanel に追加する余地あり。

### 確認が必要な事項

- `~/.motiva/sessions/*.json` の実際のフィールド (SessionSchema以外に何が書かれているか)
- PipelineState の永続化パス (`~/.motiva/pipelines/` か `~/.motiva/sessions/` 内か)
- 1セッション = 1ステージ なのか 1セッション = 1パイプライン全体なのかの実装上の対応関係
