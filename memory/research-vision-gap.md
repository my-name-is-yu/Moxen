# マルチエージェント委譲設計 — ビジョンとのギャップ分析

> 分析対象: `docs/design/multi-agent-delegation.md` vs `docs/vision.md`, `docs/mechanism.md`, `docs/design/task-lifecycle.md`, `docs/design/execution-boundary.md`
> 作成日: 2026-03-19

---

## 概要

マルチエージェント委譲設計（Issue #33）は「コーディングタスクのパイプライン化」としては整合性が高い。しかし、ビジョンが描く「愛犬の健康管理から売上2倍まで、年単位で動き続けるパートナー」という射程と比較すると、7つの構造的ギャップが存在する。

---

## 1. ビジョンとの整合性：ドメイン汎用性の欠如

**現状（Confirmed）**

`multi-agent-delegation.md` の例示はコードタスク中心だ。
- `TaskRole = "implementor" | "reviewer" | "verifier"` の定義は暗黙にコード成果物を前提とする
- `observeForTask()` が収集するのは「対象ファイル・関連テスト・依存モジュール」——コードリポジトリ固有の概念
- `file_ownership` による競合防止はファイルシステムを前提とする
- Layer 1 検証の例（`task-lifecycle.md` §5）は「テスト実行・型チェック・lint」

**ビジョンとの乖離（Confirmed）**

ビジョン §5.8 は「AIエージェントへの指示、API呼び出しの委譲、コード実行の依頼、外部サービス連携の設定」を委譲レイヤーのスコープとする。vision.md §3 の代表例「愛犬と幸せに暮らしたい」ではコードファイルは存在しない。

**具体的な改善案**

`TaskRole` の定義を成果物型に抽象化する：

```typescript
type TaskDomain = "code" | "data" | "api_action" | "research" | "communication" | "monitoring";

// observeForTask() は domain に応じて収集内容を切り替える
// code → ファイル・テスト・依存モジュール
// data → データソース・スキーマ・前回観測値
// api_action → エンドポイント仕様・レート制限・認証状態
// research → 既知の知識・未解決の問いのリスト
```

`PipelineStage` に `domain` フィールドを追加し、`verifier` ステージが domain に応じた検証方法（ファイル確認 vs API応答確認 vs メトリクス変化）を選択できるようにする。これにより設計の変更は最小で、全ドメインに拡張できる。

---

## 2. 委譲レイヤーの深さ：欠落しているTaskRole

**現状（Confirmed）**

`implementor / reviewer / verifier` の3ロールは `task-lifecycle.md` §5 の3層検証に対応するが、ビジョン §5.8 が挙げる委譲先を網羅しない。

**欠落しているロール（Confirmed）**

| 欠落ロール | ビジョン根拠 | 現設計での扱い |
|-----------|------------|--------------|
| `researcher` | mechanism.md §2.5: 知識不足を検知してKnowledgeAcquisitionTaskを生成 | 未定義。knowledge_acquisition カテゴリのタスクがパイプラインに乗るが、ロールとして明示されていない |
| `deployer` | vision.md §5.8: 「適切なシステムにデプロイを委譲する」 | 未定義 |
| `monitor` | vision.md §5.7: 「ウェアラブルセンサー、DB、アナリティクス、API」の継続監視 | 未定義 |
| `notifier` | execution-boundary.md §3: 通知送信をメッセージングシステムに委譲 | 未定義 |

**具体的な改善案**

Phase 1（MVP）の範囲は `implementor / reviewer / verifier` に限定して問題ない。しかし設計書に「将来のロール拡張例」を明記し、拡張時に `TaskRole` 型と `PipelineExecutor` のどこを変えればよいかを示す。特に `researcher` ロールはコアループの `KnowledgeAcquisitionTask` と接続する必要があるため、Phase 2 で最優先に追加すべきだ。

---

## 3. Capability-aware委譲：静的アダプタ選択の問題

**現状（Confirmed）**

`PipelineStage.adapter_type` はオプショナルな文字列で、「省略時はデフォルトアダプタを使用」とある。Phase 3 で「`adapter-layer.ts` の `capabilities` フィールドを使ってロール→アダプタマッチング」と記載されているが、現時点では静的な文字列指定にとどまる。

**ビジョンとの乖離（Confirmed）**

`execution-boundary.md` §5 のCapability Registryには「コード実装エージェント・データ収集エージェント・分析エージェント」が列挙されている。`vision.md` §5.3 は「能力を自ら拡張する」と述べ、`Stage 13` の `CapabilityDetector` が実装済みだ。しかし `multi-agent-delegation.md` はこの仕組みを「Phase 3 で adapter-layer に追加する」と先送りしており、現在のパイプライン設計はCapability Registryを参照しない。

**問題の具体的な形**

タスクが `adapter_type: "claude_code_cli"` と静的指定されている場合、後でCapability Registryにより良いエージェントが登録されても、パイプラインはそれを使えない。長期稼働（ビジョン §3 の「年単位で動き続ける」）の中で能力カタログが更新されていく前提と矛盾する。

**具体的な改善案**

Phase 1 の時点から `adapter_type` を `capability_requirement` に置き換える：

```typescript
export const PipelineStageSchema = z.object({
  role: TaskRoleSchema,
  capability_requirement: z.object({
    domain: TaskDomainSchema,         // "code" | "data" | "research" など
    preferred_adapter: z.string().optional(), // 強い選好があれば指定
  }).optional(),
  prompt_override: z.string().optional(),
});
```

`PipelineExecutor` がステージ実行前に `CapabilityDetector` を呼び出し、要件に合うアダプタを動的に選択する。これにより能力カタログの更新がパイプラインに自動的に反映される。

---

## 4. Strategy-task接続：仮説駆動のタスク生成との接続断絶

**現状（Confirmed）**

`multi-agent-delegation.md` はタスクがすでに存在することを前提に、そのタスクをどうパイプライン化するかを記述している。しかし、どの戦略（`Strategy` エンティティ）に基づいてこのタスクが生成されたかの情報が `TaskPipeline` スキーマに存在しない。

**ビジョンとの乖離（Confirmed）**

`portfolio-management.md` の `Strategy` エンティティには `hypothesis`（仮説）と `expected_effect`（期待される効果）が含まれる。`mechanism.md` §2.3 は「仮説を生成し、効果を計測し、続行するか撤退するかを判断する」と述べる。パイプラインの実行結果を戦略の効果計測（`Strategy.effectiveness_score`）にフィードバックするパスが設計に存在しない。

**具体的な改善案**

`TaskPipeline` に `strategy_id` を追加する：

```typescript
export const TaskPipelineSchema = z.object({
  stages: z.array(PipelineStageSchema).min(1),
  fail_fast: z.boolean().default(true),
  shared_context: z.string().optional(),
  strategy_id: z.string().optional(), // このパイプラインが属する戦略ID
});
```

`PipelineExecutor` の完了時に `strategy_id` が存在する場合、`PortfolioManager.recordTaskResult()` を呼び出して効果計測データを更新する。これにより「パイプライン成果 → 戦略効果スコア → リバランス」のサイクルが閉じる。

---

## 5. 長期永続性：再起動をまたぐタスク継続の欠如

**現状（Confirmed）**

`multi-agent-delegation.md` の `PipelineStageSchema` と `StageResultSchema` はインメモリの実行状態を表す。設計書全体を通じて、パイプライン実行の中断・再開・永続化については言及がない。

**ビジョンとの乖離（Confirmed）**

ビジョン §3 は「セッションが終わっても、日が変わっても、月が変わっても、ゴールが達成されるまで動き続ける」と述べる。デーモン再起動、プロセスクラッシュ、ユーザーがPCをシャットダウンした場合、実行中のパイプラインはどうなるか——現設計ではスコープ外だ。

`task-lifecycle.md` §4 の `execution_state` は `status: "running" | "completed" | "timed_out" | "error"` をもつが、これはタスク単位の状態であり、パイプラインのステージ進行状況は含まない。

**具体的な改善案**

`PipelineState` を永続化する仕組みを追加する：

```typescript
// src/types/pipeline.ts に追加
export const PipelineStateSchema = z.object({
  pipeline_id: z.string(),
  task_id: z.string(),
  current_stage_index: z.number(),
  completed_stages: z.array(StageResultSchema),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  started_at: z.string(), // ISO datetime
  updated_at: z.string(),
});
```

`PipelineExecutor` が各ステージ完了後に `StateManager` 経由でこのスナップショットをファイルに書き込む。再起動時に `core-loop.ts` が `interrupted` 状態のパイプラインを検出し、`current_stage_index` から再開する。

---

## 6. エラー回復の深さ：2-strikeモデルの限界

**現状（Confirmed）**

現設計は「1回目失敗→プロンプト調整してリトライ、2回目失敗→人間にエスカレーション」の2-strikeモデルだ。

**問題（Confirmed）**

長期稼働システムで2回失敗するたびに人間介入を要求すると、以下の問題が生じる：

1. **ノイズ化**: 月単位で稼働していると人間への通知が頻発し、ユーザーが通知疲れを起こす。重要なエスカレーションが埋もれる。
2. **粒度の問題**: `task-lifecycle.md` §2.8 の `consecutive_failure_count` は「3回で escalate」という独立した閾値を持つ。パイプラインの「2回で人間へ」と競合する可能性がある。
3. **回復戦略の欠如**: 失敗したのがどのステージか（implementor/verifier/reviewer）によって適切な対応が異なる。`implementor` の失敗なら別のアダプタで再試行すべき場合もある。`verifier` の失敗は環境問題かもしれない。現設計はこの区別をしない。

**具体的な改善案**

2段階から3段階のエスカレーションに拡張する：

```
1回目の失敗 → 同ステージをプロンプト調整してリトライ（現行と同じ）
2回目の失敗 → アダプタを切り替えて再試行（別エージェントへ委譲）
             ただし alternative_adapter が CapabilityRegistry に存在する場合のみ
3回目の失敗 or アダプタ切り替えも不可 → 人間にエスカレーション
```

加えて、失敗したステージ種別に応じた分岐を追加する：
- `verifier` 失敗が連続する場合は「環境問題」と分類し、タスク自体を失敗とせず環境確認タスクを先に生成する
- `reviewer` 失敗は `task-lifecycle.md` §5 の Layer1/Layer2 矛盾解消ルールに従う（既存設計に戻る）

---

## 7. 欠落しているパターン：実世界のオーケストレーションシステムから

以下は現設計にない、長期稼働オーケストレーターに必要なパターンだ。

### 7.1 タイムアウトとデッドライン伝播（Kubernetes: Pod termination grace period）

**現状（Uncertain）**: `task-lifecycle.md` §4 の `execution_state.timeout_at` はタスク単位のタイムアウトを持つが、パイプライン全体のタイムアウトが存在しない。

**問題**: Largeパイプライン（`implementor(並列) → verifier → reviewer`）で最初のステージが長時間かかる場合、後続ステージの実行可能時間が食いつぶされる。タスクの `estimated_duration`（`task-lifecycle.md` §2.7）を使って、パイプライン全体の締切からステージごとの締切を逆算する仕組みが必要だ。

**改善案**: `TaskPipelineSchema` に `deadline_at: z.string().optional()` を追加。`PipelineExecutor` が各ステージ開始時に「残り時間 < 最小実行時間」なら即座に `fail` として次のステージに進む。

### 7.2 冪等性保証（Workflow engines: idempotency key）

**現状（Confirmed欠落）**: パイプラインステージの冪等性が保証されていない。再起動後に同じステージが2回実行されると、`implementor` がコードを重複適用する可能性がある。

**改善案**: `StageResult` に `idempotency_key: string`（`task_id + stage_index + attempt`の組み合わせ）を追加。`PipelineExecutor` がステージ開始前に同キーの結果が存在するかをチェックし、存在すれば再実行をスキップする。

### 7.3 サーキットブレーカー（Microservices: circuit breaker）

**現状（Confirmed欠落）**: 特定のアダプタが繰り返し失敗する場合（外部サービスが停止、APIレート制限超過等）、そのアダプタへの委譲を止める仕組みがない。

**改善案**: `AdapterLayer` にアダプタごとの連続失敗カウントを追加。閾値（例: 5回連続失敗）を超えたアダプタを `circuit_open` 状態にし、一定時間後に `half_open` で試行再開。`PipelineExecutor` はアダプタ選択時に `circuit_open` のアダプタを除外する。

### 7.4 バックプレッシャー（Stream processing: backpressure）

**現状（Uncertain）**: `parallel-executor.ts`（Phase 2）が `Promise.all` で並列実行するが、同時実行数の上限が設計されていない。

**問題**: ビジョン §5.5 のポートフォリオアプローチで複数ゴール・複数戦略が同時稼働すると、エージェントへの委譲が爆発的に増加する可能性がある。外部APIのレート制限やシステムリソースの制約を超える。

**改善案**: `parallel-executor.ts` にセマフォ（`concurrency_limit`、デフォルト: 3）を組み込む。`CrossGoalPortfolio` の `allocation` 比率をセマフォのウェイトとして使い、優先度の高いゴールから先にスロットを確保する。

---

## 総合評価

| ギャップ | 重要度 | 現設計での対応 | 推奨フェーズ |
|---------|--------|--------------|------------|
| ドメイン汎用性の欠如 | 高 | 暗黙にコード前提 | Phase 1 改訂 |
| TaskRole の欠落（特に `researcher`） | 高 | Phase 2 以降に先送り | Phase 2 最優先 |
| Capability-aware委譲 | 高 | Phase 3 に先送り | Phase 2 で前倒し |
| Strategy-task接続断絶 | 中 | 設計に存在しない | Phase 2 |
| 長期永続性（再起動をまたぐ継続） | 高 | スコープ外 | Phase 1 に追加 |
| 2-strikeモデルの限界 | 中 | 現行設計どおり | Phase 2 |
| 冪等性保証の欠如 | 高 | 設計に存在しない | Phase 1 に追加 |
| サーキットブレーカー欠如 | 低 | 設計に存在しない | Phase 3 |
| バックプレッシャー欠如 | 低 | 設計に存在しない | Phase 3 |

**最も急ぎ対応すべきもの（Phase 1 への追加）**: `PipelineState` の永続化と冪等性キーの2点。この2つがなければ「年単位で動き続ける」という最も基本的なビジョン要件を満たせない。どちらも実装コストは小さく（50行未満）、後から追加するとリファクタリングが大きくなる。

**設計書の根本的な問題**: `multi-agent-delegation.md` は「どうパイプライン化するか」には詳しいが、「なぜこの設計がビジョンのどの要件を満たすか」のトレーサビリティがない。各 §7.x パターンが欠けていても「コーディングタスクのパイプライン化」としては動く。問題はビジョンが要求するスケール（ドメイン多様性・長期稼働・自律的能力拡張）になった瞬間に設計の前提が崩れることだ。
