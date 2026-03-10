# Stage 3 実装リサーチ — 5モジュール詳細仕様

作成日: 2026-03-10
対象: LLMClient, EthicsGate, SessionManager, StrategyManager, GoalNegotiator

---

## 0. 前提: 既存コード規約

**コードパターン（実装済みモジュールから確認済み）**:

- クラスベース: StateManager, TrustManager, DriveSystem, ObservationEngine, StallDetector, SatisficingJudge
- 純粋関数: GapCalculator, DriveScorer
- ESMインポート: `.js` 拡張子必須（`tsconfig.json` の `"module": "Node16"` による）
- 型定義: Zodスキーマ + `z.infer<>` パターン
- DI: コンストラクタ引数でStateManagerを受け取る（例: `new TrustManager(stateManager)`）
- ファイル永続化: StateManagerの `readRaw` / `writeRaw` を使う。atomic write
- テストパターン:
  - `vitest` + `describe` / `it` / `expect`
  - クラスのテスト: `beforeEach` でtmpDir + StateManager + インスタンス生成、`afterEach` でtmpDir削除
  - LLMが必要なテスト: モック差し替えを前提とした設計
  - 純粋関数のテスト: DI不要、直接呼び出し

**Anthropic SDK**:
- 現状 `package.json` に未追加（`"dependencies": { "zod": "^3.22.0" }` のみ）
- Stage 3開始時に `@anthropic-ai/sdk` を追加が必要 — **最初の作業**

**既存型エクスポート（`src/types/index.ts` 経由でエクスポート済み）**:
- `core.ts`: `ThresholdSchema`, `ObservationMethodSchema`, `FeasibilityAssessmentEnum`, `NegotiationResponseTypeEnum`, `ReversibilityEnum`, `VerdictEnum`, `TaskStatusEnum`, `StallTypeEnum`, `StallCauseEnum`, `StrategyStateEnum`, `DurationSchema`, `DependencyTypeEnum`, `ReportTypeEnum`, `VerbosityLevelEnum` など
- `goal.ts`: `GoalSchema`, `GoalTreeSchema`, `DimensionSchema`, `GoalStatusEnum`, `GoalNodeTypeEnum`
- `session.ts`: `SessionSchema`, `SessionTypeEnum`, `ContextSlotSchema` — **既存で完全に定義済み**
- `strategy.ts`: `StrategySchema`, `PortfolioSchema`, `ExpectedEffectSchema`, `ResourceEstimateSchema` — **既存で完全に定義済み**

---

## 1. LLMClient (`src/llm-client.ts`)

### 役割

Anthropic SDKのラッパー。全モジュールのLLM呼び出しを統一インターフェースで提供。テスト時にモック差し替え可能なDI構造。

### 実装ファイル

`src/llm-client.ts` — **新規**

### 必要な型定義（新規作成 or インライン定義）

```typescript
// src/llm-client.ts 内にインライン定義推奨
interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

interface LLMRequestOptions {
  model?: string;             // デフォルト: "claude-opus-4-5" 等
  max_tokens?: number;        // デフォルト: 4096
  system?: string;            // システムプロンプト
  temperature?: number;       // デフォルト: 0 (決定論的)
}

interface LLMResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason: string;
}

// テスト用モックインターフェース
interface ILLMClient {
  sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
```

### 公開API

```typescript
export class LLMClient implements ILLMClient {
  constructor(apiKey?: string)  // 省略時はENV("ANTHROPIC_API_KEY")から取得

  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse>

  parseJSON<T>(content: string, schema: ZodSchema<T>): T
  // LLM返却テキストからJSONを抽出し、Zodスキーマでバリデーション
}

// テスト用のモッククラスも同一ファイルにエクスポート
export class MockLLMClient implements ILLMClient {
  constructor(responses: string[])  // 順番に返すレスポンスのリスト
  async sendMessage(...): Promise<LLMResponse>
  parseJSON<T>(content: string, schema: ZodSchema<T>): T
}
```

### 実装の注意点

- `sendMessage` はリトライロジックを内包（デフォルト: 最大3回、指数バックオフ）
- JSONパース失敗時は `parseJSON` が例外を投げる（呼び出し元でcatch）
- モデル名はデフォルト定数として定義（`DEFAULT_MODEL = "claude-opus-4-5"` 相当）
- `ILLMClient` インターフェースを全モジュールの型として使用（モック差し替えを可能に）

### 依存

- `@anthropic-ai/sdk` （package.jsonへの追加が必要）
- `zod`

---

## 2. EthicsGate (`src/ethics-gate.ts`)

### 役割

独立クラス。LLMによる倫理・法的判定（Layer 2のみ、MVPはLayer 1未実装）。GoalNegotiatorのStep 0として呼ばれる。すべての判定をログに永続化。

### 実装ファイル

`src/ethics-gate.ts` — **新規**

### 必要な型定義（新規 Zodスキーマ）

`src/types/ethics.ts` を新規作成:

```typescript
import { z } from "zod";

export const EthicsVerdictEnum = z.enum(["reject", "flag", "pass"]);
export type EthicsVerdictType = z.infer<typeof EthicsVerdictEnum>;

export const EthicsVerdictSchema = z.object({
  verdict: EthicsVerdictEnum,
  category: z.string(),
  reasoning: z.string(),
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type EthicsVerdict = z.infer<typeof EthicsVerdictSchema>;

export const EthicsSubjectTypeEnum = z.enum(["goal", "subgoal", "task"]);

export const EthicsLogSchema = z.object({
  log_id: z.string(),
  timestamp: z.string(),
  subject_type: EthicsSubjectTypeEnum,
  subject_id: z.string(),
  subject_description: z.string(),
  verdict: EthicsVerdictSchema,
  rejection_delivered: z.object({
    message: z.string(),
    delivered_at: z.string(),
  }).optional(),
  user_confirmation: z.object({
    risks_presented: z.array(z.string()),
    user_response: z.enum(["acknowledged", "cancelled", "pending"]),
    responded_at: z.string().optional(),
    acknowledged_risks: z.array(z.string()).optional(),
  }).optional(),
});
export type EthicsLog = z.infer<typeof EthicsLogSchema>;
```

`src/types/index.ts` に `export * from "./ethics.js"` を追加。

### 公開API

```typescript
export class EthicsGate {
  constructor(stateManager: StateManager, llmClient: ILLMClient)

  async check(
    subjectType: "goal" | "subgoal" | "task",
    subjectId: string,
    description: string,
    context?: string  // 追加文脈（上位ゴールの説明等）
  ): Promise<EthicsVerdict>

  async checkMeans(
    taskId: string,
    taskDescription: string,
    means: string  // タスクの実行手段の説明
  ): Promise<EthicsVerdict>
  // Phase 2向け（MVP: 実装するが呼び出し元はTaskLifecycle統合後）

  getLogs(filter?: {
    subjectId?: string;
    verdict?: "reject" | "flag" | "pass";
  }): EthicsLog[]
}
```

### 主要メソッドの動作

**`check()`**:
1. LLMに倫理判定プロンプトを送信（`character.md` Appendix Aのペルソナを含む）
2. 返却JSON を `EthicsVerdictSchema` でパース
3. `confidence < 0.6` の場合は自動的に `verdict = "flag"` にオーバーライド
4. `EthicsLog` を生成し `~/.motiva/ethics/ethics-log.jsonl` に追記（JSONL形式）
5. 判定結果を返す

**LLMプロンプト設計**:
- システムプロンプト: `character.md` Appendix Aのペルソナ + 保守的バイアス指示
- 出力形式: JSON (`{ verdict, category, reasoning, risks, confidence }`)
- 保守的バイアス: 「不確実なときは reject よりも flag を選ぶ。明らかにNGのときだけ reject」

### 永続化

- パス: `~/.motiva/ethics/ethics-log.jsonl`
- 形式: JSONL（1行1エントリ）— StateManagerの `readRaw` / `writeRaw` で管理
- pass判定も含め全件記録

### エラーハンドリング

- LLM呼び出し失敗時: エラーを投げる（呼び出し元でcatch、ゴール受け入れ不可として扱う）
- JSONパース失敗時: `{ verdict: "flag", category: "parse_error", ... }` を返す（保守的フォールバック）

### 数値定数

- `CONFIDENCE_FLAG_THRESHOLD = 0.6` — これ未満は自動的に `flag` 扱い

### 依存

- `StateManager`
- `ILLMClient`

---

## 3. SessionManager (`src/session-manager.ts`)

### 役割

4種セッション（タスク実行/観測/タスクレビュー/ゴールレビュー）のコンテキスト組み立て。MVPは優先度1〜4の固定テンプレート（動的バジェット管理なし）。

### 実装ファイル

`src/session-manager.ts` — **新規**

### 既存型（追加不要、`src/types/session.ts` に定義済み）

- `Session` / `SessionSchema` — 完全定義済み
- `SessionType` / `SessionTypeEnum` — 4種完全定義済み
- `ContextSlot` / `ContextSlotSchema` — 完全定義済み（priority, label, content, token_estimate）

### 公開API

```typescript
export class SessionManager {
  constructor(stateManager: StateManager)

  // セッション作成
  createSession(
    sessionType: SessionType,
    goalId: string,
    taskId: string | null,
    contextBudget?: number  // デフォルト: DEFAULT_CONTEXT_BUDGET
  ): Session

  // コンテキスト組み立て（セッション種別ごと）
  buildTaskExecutionContext(
    goalId: string,
    taskId: string,
    isRetry?: boolean  // リトライ時は前回結果を含む（優先度5相当）
  ): ContextSlot[]

  buildObservationContext(
    goalId: string,
    dimensionNames: string[]
  ): ContextSlot[]

  buildTaskReviewContext(
    goalId: string,
    taskId: string
  ): ContextSlot[]

  buildGoalReviewContext(goalId: string): ContextSlot[]

  // セッション終了
  endSession(
    sessionId: string,
    resultSummary: string
  ): void

  // セッション取得
  getSession(sessionId: string): Session | null
  getActiveSessions(goalId: string): Session[]
}
```

### 主要メソッドの動作

**コンテキスト組み立ての共通ルール（MVPの固定テンプレート）**:

優先度1〜4を固定で含める。優先度5〜6は含めない（バジェット管理の簡略化）。

| セッション種別 | 必ず含む（優先度1〜4） | 強制除外 |
|-------------|---------------------|--------|
| タスク実行 | タスク定義・成功基準、対象次元状態、直近観測サマリー、制約 | ゴール全体の履歴、他ゴール情報、戦略的背景 |
| 観測 | ゴール定義・次元定義、観測手段、前回観測結果、制約 | 直前タスクの詳細、実行セッションの試行内容 |
| タスクレビュー | タスク定義・成功基準、成果物へのアクセス手段 | ゴールレベルの文脈、タスク生成背景、実行者の自己申告 |
| ゴールレビュー | ゴール定義(全体)、状態ベクトル・直近変化、達成閾値 | 個々のタスク実行詳細、実行履歴全体 |

**`buildObservationContext`**: 観測セッションに実行詳細を渡さないことが最重要（バイアス防止）

**`buildTaskReviewContext`**: 実行者の自己申告を渡さないことが最重要（独立判断の確保）

**セッション終了条件** (SessionManagerが判断するのではなく、呼び出し元が `endSession()` を呼ぶ):
- タスク完了時（1セッション1タスク原則）
- コンテキスト上限接近時（呼び出し元が検知して終了）
- 停滞検知時（StallDetectorが検知して終了）

### 永続化

- `Session` は StateManagerの `readRaw` / `writeRaw` で管理
- パス: `~/.motiva/sessions/<session_id>.json`

### 数値定数

```typescript
const DEFAULT_CONTEXT_BUDGET = 50_000;  // トークン概算（モデルの50%相当）
```

### 依存

- `StateManager`
- `GoalSchema` (型参照のみ)
- `SessionSchema` (型参照のみ)

---

## 4. StrategyManager (`src/strategy-manager.ts`)

### 役割

単一戦略の逐次管理（MVP）。状態遷移（candidate → active → completed/terminated）。StallDetectorと連動してピボット判断をトリガー。LLMで1〜2候補生成し最上位を自動選択。

### 実装ファイル

`src/strategy-manager.ts` — **新規**

### 既存型（追加不要、`src/types/strategy.ts` に定義済み）

```typescript
// 以下は全て定義済み
Strategy         // StrategySchema で完全定義
Portfolio        // PortfolioSchema で完全定義
ExpectedEffect   // ExpectedEffectSchema
ResourceEstimate // ResourceEstimateSchema
StrategyState    // "candidate"|"active"|"evaluating"|"suspended"|"completed"|"terminated"
```

`strategy_id` フィールドについて: `src/types/task.ts` に `strategy_id: z.string().nullable().default(null)` の追加が必要 — **別途 task.ts の変更が必要**（`roadmap-research.md` §8.4 参照）

### 公開API

```typescript
export class StrategyManager {
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient
  )

  // 戦略生成（LLM呼び出し）
  async generateCandidates(
    goalId: string,
    primaryDimension: string,  // DriveScorer.rankDimensions()の1位
    targetDimensions: string[],
    context: {
      currentGap: number;
      pastStrategies: Strategy[];  // 過去の試み（LLMへのコンテキスト）
    }
  ): Promise<Strategy[]>  // 1〜2候補を返す

  // アクティブ戦略の設定（最上位候補を自動選択）
  async activateBestCandidate(goalId: string): Promise<Strategy>

  // 状態遷移
  updateState(
    strategyId: string,
    newState: StrategyState,
    metadata?: { effectiveness_score?: number }
  ): void

  // 停滞連動（StallDetector第2検知で呼ばれる）
  async onStallDetected(
    goalId: string,
    stallCount: number  // 同一停滞の検知回数
  ): Promise<Strategy | null>
  // stallCount >= 2 の場合: 現在戦略をterminated → 新候補生成 → activate
  // stallCount == 1 の場合: null（戦略変更なし、character.md軸2の早期ピボット）
  // ※ character.md軸2: 第1検知でピボット提案。これはStrategyManagerへの呼び出しであり、
  //   実際の戦略切り替えは第2検知以降という解釈（roadmap.mdの記述と照合が必要）

  // クエリ
  getActiveStrategy(goalId: string): Strategy | null
  getPortfolio(goalId: string): Portfolio | null
  getStrategyHistory(goalId: string): Strategy[]
}
```

### 主要メソッドの動作

**`generateCandidates()`**:
1. LLMに候補生成プロンプトを送信
   - 入力: primaryDimension, targetDimensions, 過去の試み一覧, currentGap
   - 出力: `Strategy[]` (1〜2件)
2. 返却JSONを `StrategySchema` でバリデーション
3. `state: "candidate"` で保存

**`activateBestCandidate()`**:
1. `generateCandidates()` の1件目（最上位）を選択
2. `gap_snapshot_at_start` に現在のgap値を設定
3. `state: "active"`, `started_at` を設定
4. `Portfolio` に記録

**`onStallDetected()` の停滞連動**:
- `StallDetector` 第2検知後（`consecutive_stall_count >= 2`）に呼ばれる想定
- 現戦略の `state` を `"terminated"` に更新
- `consecutive_stall_count` インクリメント
- 新候補を生成してactivate
- 生成できる候補がない場合は `null` を返す（呼び出し元がエスカレーション処理）

**タスク選択ルール**（StrategyManagerの責任ではなく参考）:
- 「最も待たされている戦略」から決定論的に選択（MVPは1戦略のみなので単純）

**効果計測**（MVP簡略）:
- `gap_snapshot_at_start` と現在のgapを差分で `effectiveness_score` に記録

### 永続化

- `Portfolio`: `~/.motiva/strategies/<goal_id>/portfolio.json`
- `Strategy[]` history: `~/.motiva/strategies/<goal_id>/strategy-history.json`
- StateManagerの `readRaw` / `writeRaw` で管理

### 依存

- `StateManager`
- `ILLMClient`
- `StrategySchema`, `PortfolioSchema` (型参照)

---

## 5. GoalNegotiator (`src/goal-negotiator.ts`)

### 役割

6ステップフロー（Step 0〜5）でゴールを交渉し、合意済みゴールを状態ベクトルとして確立。最も複雑なLayer 3モジュール。

### 実装ファイル

`src/goal-negotiator.ts` — **新規**

### 必要な型定義（新規 Zodスキーマ）

`src/types/negotiation.ts` を新規作成:

```typescript
import { z } from "zod";

export const NegotiationStepEnum = z.enum([
  "ethics_check",
  "goal_intake",
  "dimension_decomposition",
  "baseline_observation",
  "feasibility_evaluation",
  "response_generation",
]);

export const FeasibilityPathEnum = z.enum(["quantitative", "qualitative", "hybrid"]);

export const DimensionDecompositionSchema = z.object({
  name: z.string(),
  label: z.string(),
  threshold_type: z.enum(["min", "max", "range", "present", "match"]),
  threshold_value: z.union([z.number(), z.string(), z.boolean()]).nullable(),
  observation_method_hint: z.string(),
});
export type DimensionDecomposition = z.infer<typeof DimensionDecompositionSchema>;

export const FeasibilityResultSchema = z.object({
  dimension: z.string(),
  path: FeasibilityPathEnum,
  feasibility_ratio: z.number().nullable(),  // 定量評価時のみ
  assessment: z.enum(["realistic", "ambitious", "infeasible"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  key_assumptions: z.array(z.string()),
  main_risks: z.array(z.string()),
});
export type FeasibilityResult = z.infer<typeof FeasibilityResultSchema>;

export const NegotiationLogSchema = z.object({
  goal_id: z.string(),
  timestamp: z.string(),
  is_renegotiation: z.boolean().default(false),
  renegotiation_trigger: z.enum(["stall", "new_info", "user_request"]).nullable().default(null),

  step2_decomposition: z.object({
    dimensions: z.array(DimensionDecompositionSchema),
    method: z.literal("llm"),
  }).nullable().default(null),

  step3_baseline: z.object({
    observations: z.array(z.object({
      dimension: z.string(),
      value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
      confidence: z.number(),
      method: z.string(),
    })),
  }).nullable().default(null),

  step4_evaluation: z.object({
    path: FeasibilityPathEnum,
    dimensions: z.array(FeasibilityResultSchema),
  }).nullable().default(null),

  step5_response: z.object({
    type: z.enum(["accept", "counter_propose", "flag_as_ambitious"]),
    accepted: z.boolean(),
    initial_confidence: z.enum(["high", "medium", "low"]),
    user_acknowledged: z.boolean().default(false),
    counter_proposal: z.object({
      realistic_target: z.number(),
      reasoning: z.string(),
      alternatives: z.array(z.string()),
    }).nullable().default(null),
  }).nullable().default(null),
});
export type NegotiationLog = z.infer<typeof NegotiationLogSchema>;
```

`src/types/index.ts` に `export * from "./negotiation.js"` を追加。

### 公開API

```typescript
export class GoalNegotiator {
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    ethicsGate: EthicsGate,
    observationEngine: ObservationEngine
  )

  // メインフロー: 6ステップ交渉
  async negotiate(
    rawGoalDescription: string,
    options?: {
      deadline?: string;      // ISO 8601
      constraints?: string[];
      timeHorizonDays?: number;  // デフォルト: 90日
    }
  ): Promise<{
    goal: Goal;
    response: NegotiationResponse;
    log: NegotiationLog;
  }>

  // サブゴール分解 + 全サブゴールの倫理チェック
  async decompose(
    goalId: string,
    parentGoal: Goal
  ): Promise<{
    subgoals: Goal[];
    rejectedSubgoals: Array<{ description: string; reason: string }>;
  }>

  // 再交渉（3トリガー対応）
  async renegotiate(
    goalId: string,
    trigger: "stall" | "new_info" | "user_request",
    context?: string  // トリガーに関する文脈
  ): Promise<{
    goal: Goal;
    response: NegotiationResponse;
    log: NegotiationLog;
  }>

  // 交渉ログ取得
  getNegotiationLog(goalId: string): NegotiationLog | null
}
```

### NegotiationResponse 型

`src/types/core.ts` に `NegotiationResponseTypeEnum` は既存（`accept`, `counter_propose`, `flag_as_ambitious`）。

```typescript
// goal-negotiator.ts 内で定義（or src/types/negotiation.ts に追加）
interface NegotiationResponse {
  type: NegotiationResponseType;
  message: string;           // ユーザー向けメッセージ（LLM生成）
  accepted: boolean;
  initial_confidence: "high" | "medium" | "low";
  counter_proposal?: {
    realistic_target: number;
    reasoning: string;
    alternatives: string[];
  };
  flags?: string[];          // flag_as_ambitious時のリスク一覧
}
```

### 主要メソッドの動作

**`negotiate()` — 6ステップフロー**:

**Step 0: 倫理ゲート**
- `ethicsGate.check("goal", tempId, rawGoalDescription)` を呼ぶ
- `verdict === "reject"` → 即座にエラーを投げる（Step 1以降に進まない）
- `verdict === "flag"` → NegotiationResponseに `flags` を含めて返す（ユーザー確認待ち）
- `verdict === "pass"` → 続行

**Step 1: ゴール受け取り**
- スコープ確認（時間軸・規模感・制約）
- 不明な場合はデフォルト値を仮定（`timeHorizonDays = 90`）

**Step 2: 次元分解プローブ (LLM)**
- LLMに次元分解プロンプトを送信
- 出力: `DimensionDecomposition[]`
- `GoalSchema.dimensions` の型に変換して暫定ゴールを構築

**Step 3: ベースライン観測**
- `observationEngine` を使って各次元の現在値を取得
- 観測不可の次元は `value: null, confidence: 0` で記録

**Step 4: 実現可能性評価 (ハイブリッド)**

定量評価（過去データあり）:
```
feasibility_ratio = (necessary_change_rate) / (observed_change_rate)
necessary_change_rate = |goal_value - current_value| / time_horizon_days
observed_change_rate = 過去データから算出
```

判定閾値（**character.md設定、デフォルトの3.0から変更**）:
- `feasibility_ratio <= 1.5` → `"realistic"`
- `feasibility_ratio <= 2.5` → `"ambitious"` ← **キャラクター閾値（2.5）**
- `feasibility_ratio > 2.5` → `"infeasible"` → カウンター提案トリガー

定性評価（新規ドメイン）:
- LLMに評価させる: `assessment`, `confidence`, `reasoning`, `key_assumptions`, `main_risks`
- 保守的バイアス: 不確実時は `flag_as_ambitious` 寄りに

**Step 5: 応答生成 (LLM)**

```
応答A (accept): すべての次元が realistic or ambitious
応答B (counter_propose): infeasible次元あり、代替目標が算出可能
  realistic_target = 現在値 + (観測変化率 × 利用可能日数 × 1.3)  ← 係数1.3 (character.md)
応答C (flag_as_ambitious): 信頼度が低い / 定性評価でリスクあり
```

- ユーザーがcounter_proposeを押し通した場合: `confidence_flag = "low"`, `user_override = true`, `feasibility_note` を設定して受諾

**`decompose()` の倫理再チェック**:
1. LLMでサブゴール群を生成
2. 各サブゴールに `ethicsGate.check("subgoal", ...)` を実行
3. `reject` されたサブゴールを除外して返す
4. 必須サブゴールが拒否された場合は上位ゴール自体を拒否

### 永続化

- 交渉ログ: `~/.motiva/goals/<goal_id>/negotiation-log.json`
- 合意済みゴール: StateManagerの `GoalTree` に保存

### 数値定数

```typescript
// character.md由来 — コード上で定数として明示する
const FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS = 2.5;  // デフォルト3.0から変更
const FEASIBILITY_RATIO_THRESHOLD_REALISTIC = 1.5;
const REALISTIC_TARGET_ACCELERATION_FACTOR = 1.3;   // デフォルト1.5から変更
const DEFAULT_TIME_HORIZON_DAYS = 90;
const RENEGOTIATION_TRIGGER_RATE_DEVIATION_THRESHOLD = 0.5;  // 観測変化率が予測の50%未満で再交渉
const RENEGOTIATION_CONSECUTIVE_LOOPS = 3;  // デフォルト連続ループ数
```

### エラーハンドリング

- EthicsGate reject → `EthicsRejectedError` を投げる
- LLM呼び出し失敗 → 上位に伝搬（ゴール交渉プロセス全体を中断）
- JSONパース失敗 → `flag_as_ambitious` にフォールバック

### 依存

- `StateManager`
- `ILLMClient`
- `EthicsGate`
- `ObservationEngine` (Step 3のベースライン観測)
- 型: `GoalSchema`, `NegotiationLogSchema`, `EthicsVerdictSchema`

---

## 6. 横断的な実装ノート

### 新規作成が必要なファイル

| ファイル | 種別 | 優先度 |
|--------|------|-------|
| `src/llm-client.ts` | 新規実装 | 最高（他の全モジュールの前提） |
| `src/types/ethics.ts` | 新規型定義 | EthicsGate前に必要 |
| `src/types/negotiation.ts` | 新規型定義 | GoalNegotiator前に必要 |
| `src/ethics-gate.ts` | 新規実装 | GoalNegotiator前に必要 |
| `src/session-manager.ts` | 新規実装 | GoalNegotiator前に必要 |
| `src/strategy-manager.ts` | 新規実装 | 独立（GoalNegotiatorと並行可） |
| `src/goal-negotiator.ts` | 新規実装 | EthicsGate + SessionManager後 |

### 変更が必要な既存ファイル

| ファイル | 変更内容 |
|--------|---------|
| `package.json` | `@anthropic-ai/sdk` を dependencies に追加 |
| `src/types/index.ts` | `export * from "./ethics.js"` と `export * from "./negotiation.js"` を追加 |
| `src/types/task.ts` | `strategy_id: z.string().nullable().default(null)` フィールドを追加 |
| `src/index.ts` | 新モジュールのエクスポートを追加 |

### `src/types/index.ts` への追加エクスポート

```typescript
export * from "./ethics.js";
export * from "./negotiation.js";
```

### `src/index.ts` への追加エクスポート

```typescript
export type { ILLMClient } from "./llm-client.js";
export { LLMClient, MockLLMClient } from "./llm-client.js";
export { EthicsGate } from "./ethics-gate.js";
export { SessionManager } from "./session-manager.js";
export { StrategyManager } from "./strategy-manager.js";
export { GoalNegotiator } from "./goal-negotiator.js";
```

### テスト設計方針

- **LLMClient**: `MockLLMClient` を使い、実際のAPI呼び出しなしに全ロジックをテスト
- **EthicsGate**: MockLLMClientで `reject` / `flag` / `pass` の3ケース + `confidence < 0.6` の自動flag
- **SessionManager**: LLM不要。4種コンテキスト組み立ての内容検証（バイアス情報の除外確認が最重要）
- **StrategyManager**: MockLLMClientで候補生成、状態遷移の全パスをテスト
- **GoalNegotiator**: MockLLMClientでStep 0〜5の全フロー + 再交渉 + サブゴール倫理チェック

テストファイルパス:
- `tests/llm-client.test.ts`
- `tests/ethics-gate.test.ts`
- `tests/session-manager.test.ts`
- `tests/strategy-manager.test.ts`
- `tests/goal-negotiator.test.ts`

---

## 7. 未解決の課題（実装前に確認が必要）

### 7.1 progress_ceiling 数値の不整合 (**Uncertain**)

- `observation.md`: self_report → 0.70、independent_review → 0.90
- `satisficing.md`: low → 0.60、medium → 0.85
- **解決方針**: `observation.md` の数値（0.70/0.90）を正として統一。`satisficing.md` は完了判断コンテキストでの意図的な厳格化として別個に扱う

### 7.2 character.md 軸2とStrategyManagerの停滞連動タイミング (**Likely**)

- `character.md` 軸2: 「第1検知の時点でピボット提案」
- `stall-detection.md` §4: 第1検知→同じ戦略の中で別アプローチ、第2検知→戦略変更
- **解釈**: 第1検知時点でユーザーにピボット提案を通知（ReportingEngine経由）するが、実際の戦略切り替えは第2検知で行う。StrategyManagerの `onStallDetected()` は第2検知から呼ばれる

### 7.3 EthicsLog の永続化形式

- JSONL（追記形式）を推奨。Statemanagerの `readRaw` / `writeRaw` がJSONL追記に対応しているか確認が必要
- 対応していない場合: 全件読み込み → 配列に追加 → 全件書き込みのパターンで実装

---

## 8. 信頼ラベル

| 情報 | ラベル |
|------|------|
| EthicsGate 型定義（EthicsVerdict, EthicsLog） | **Confirmed** |
| EthicsGate MVP = Layer 2（LLM）のみ | **Confirmed** |
| GoalNegotiator 6ステップフロー | **Confirmed** |
| feasibility_ratio 閾値 = 2.5（character.md） | **Confirmed** |
| realistic_target係数 = 1.3（character.md） | **Confirmed** |
| SessionManager 型定義（既存で完全） | **Confirmed** |
| Strategy 型定義（既存で完全） | **Confirmed** |
| task.ts への strategy_id 追加必要 | **Confirmed** |
| Anthropic SDK 未追加（package.json確認済み） | **Confirmed** |
| JSONL形式でのEthicsLog永続化 | **Likely** |
| StallDetector第1検知でピボット提案、第2検知で戦略切り替え | **Likely** |
| progress_ceiling 数値不整合の解決方針 | **Uncertain** |
