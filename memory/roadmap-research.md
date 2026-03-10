# Motiva ロードマップリサーチサマリー

作成日: 2026-03-10
対象: Stage 3以降の実装に必要な全設計ドキュメントの調査

---

## 0. 前提: 完了済みの状態

- **Stage 1 完了**: StateManager, GapCalculator, 13 Zodスキーマファイル
- **Stage 2 完了**: DriveSystem, TrustManager, DriveScorer, ObservationEngine, StallDetector, SatisficingJudge — 405テスト通過
- **残り**: Layer 3〜6（SessionManager, GoalNegotiator, StrategyManager → TaskLifecycle → CoreLoop/ReportingEngine → CLIRunner）

---

## 1. 最新コミットで追加・更新されたドキュメント

### 1.1 `docs/design/goal-ethics.md` — 新規（EthicsGate）

**役割**: GoalNegotiatorのStep 0として統合される倫理・法的ゲート。「何を目指すか」の安全を担う。

**主要機能**:
- 2層構造判定: Layer 1（カテゴリベースブロックリスト、MVP未実装）+ Layer 2（LLM文脈的判定）
- 3段階判定結果: `reject`（即拒否）/ `flag`（ユーザー確認）/ `pass`
- 適用タイミング: ゴール設定時(Step 0) / サブゴール分解後(decompose()後) / タスク生成後(generateTask()後、Phase 2) / 再交渉時
- 全判定をEthicsLogに永続記録（pass含む）

**判定結果型**:
```typescript
interface EthicsVerdict {
  verdict: "reject" | "flag" | "pass";
  category: string;
  reasoning: string;
  risks: string[];
  confidence: number;  // 0.6未満は自動的にflag扱い
}

interface EthicsLog {
  log_id: string;
  timestamp: string;
  subject_type: "goal" | "subgoal" | "task";
  subject_id: string;
  subject_description: string;
  verdict: EthicsVerdict;
  rejection_delivered?: { message: string; delivered_at: string; };
  user_confirmation?: { risks_presented: string[]; user_response: "acknowledged" | "cancelled" | "pending"; responded_at?: string; };
}
```

**LLM要求**: **あり**（Layer 2判定で必須）

**MVP実装範囲**:
- Layer 2（LLM判定）のみ実装
- GoalNegotiator Step 0として統合
- decompose()後のサブゴール再チェック実装
- TaskLifecycle統合（Phase 2）
- Layer 1ブロックリスト（Phase 2）

**依存**: GoalNegotiator（統合先）、TaskLifecycle（Phase 2連携）

**推定規模**: 中（クラス、LLMプロンプト設計、ログ永続化）

---

### 1.2 `docs/design/character.md` — 新規（Motivaペルソナ定義）

**役割**: LLMプロンプトに埋め込むMotivaDのキャラクター定義。実装コンポーネントではなく、プロンプトエンジニアリングの仕様書。

**4つの行動軸**:
1. **現実の評価 — 保守的**: GoalNegotiatorのfeasibility_ratio閾値を2.5に調整（設計デフォルト3.0の上書き）
2. **停滞時の判断 — 超・柔軟**: StallDetector第1検知時点でピボット提案
3. **事実の伝達 — 配慮的かつ率直**: ReportingEngineの詳細レポートに「次のアクション候補」フィールドを必須化
4. **レポーティング — 有事のみ説明的**: 通常サマリー（1〜2行）vs 詳細レポートの2モード

**実装への影響**:
- GoalNegotiator: feasibility_ratio判定閾値を2.5に設定（カウンター提案のrealistic_target計算式で係数1.3を使用）
- ReportingEngine: 報告モードを「通常サマリー」と「詳細レポート」に分類、詳細レポートのトリガー定義
- StallDetector: エスカレーション閾値を低めに設定（第1検知でピボット提案）

**LLM要求**: 間接的（各モジュールのLLMプロンプトにAppendix Aの英語版テキストを注入）

**推定規模**: 小（プロンプトテキストの定数定義のみ、独立モジュールなし）

---

### 1.3 `docs/design/goal-negotiation.md` — 更新（Step 0追加）

**変更点**: 交渉フローが5ステップ → 6ステップに変更（Step 0: 倫理・法的ゲートを追加）

**完全フロー**:
```
Step 0: 倫理・法的ゲート（goal-ethics.md参照）
  ↓（pass時のみ）
Step 1: ゴール受け取り（曖昧な自然言語の解釈）
  ↓
Step 2: 次元分解プローブ（LLMによる測定可能次元への分解）
  ↓
Step 3: ベースライン観測（ObservationEngine使用）
  ↓
Step 4: 実現可能性評価（定量的 + 定性的ハイブリッド）
  ↓
Step 5: 応答（受諾A / カウンター提案B / 要注意フラグC）
```

**主要機能**:
- Step 2: LLMによる次元分解（Goal, SubGoal, 閾値型まで指定）
- Step 4: 定量評価3チェック（変化率/能力/リソース）+ 定性LLM評価
- Step 5: 3種応答（feasibility_ratio > 2.5[character.md] でカウンター提案）
- §6: 再交渉トリガー3種（停滞後/新情報/ユーザー要求）
- §7: ゴールツリー階層での交渉（上位/サブゴール別）

**LLM要求**: **あり**（Step 2次元分解、Step 4定性評価、Step 5カウンター提案文生成、Step 0倫理判定）

**依存**: ObservationEngine（Step 3）、EthicsGate（Step 0）、StateManager

**推定規模**: 大（クラス、多数のLLMプロンプト、再交渉ロジック、永続ログ）

---

### 1.4 `docs/design/trust-and-safety.md` — 更新（倫理ゲート優先度0追加）

**変更点**: 安全フロアの優先順位リストに倫理・法的ゲートを最上位（優先度0）として追加。

```
優先度（高）
  0. 倫理・法的ゲート  ← NEW
  1. 永続的なゲート
  2. 取り消せない操作ルール
  3. 象限マトリクス
  4. 停滞検知のフィードバック
優先度（低）
```

**実装上の意味**: TaskLifecycleが倫理ゲートチェックを不可逆操作チェックより前に実施する必要がある。

---

### 1.5 `docs/mechanism.md` — 更新（ゴール交渉ステップ数）

**変更点**: §3「ゴール交渉」の説明がStep 5→6に更新（Step 0の倫理ゲート反映）。

---

### 1.6 `docs/architecture-map.md` — 更新（GoalNegotiator説明）

**変更点**: ゴール交渉の説明に倫理・法的ゲート（Step 0）が追加。全体的な参照整合性の更新。

---

## 2. Stage 3 実装対象（Layer 3）

### 2.1 SessionManager（`session-and-context.md`）

**役割**: セッションの起動・コンテキスト組み立て・終了を制御。セッションはステートレスな実行単位。

**主要機能**:
1. **セッション種別ごとのコンテキスト組み立て**（4種）:
   - タスク実行セッション: タスク定義+成功基準+制約+状態+リトライ情報
   - 観測セッション: ゴール定義+次元定義+観測手段+前回観測
   - タスクレビューセッション: タスク定義+成果物のみ（実行コンテキスト除外でバイアス防止）
   - ゴールレビューセッション: ゴール全体+状態ベクトル+達成閾値（タスク詳細除外）

2. **優先度ベースのコンテキスト選択アルゴリズム**（§4）:
   - コンテキストバジェット: モデルのwindowの50%（設定可能）
   - 優先度1〜4（常時）: タスク定義、対象次元状態、直近観測サマリー、制約
   - 優先度5〜6（余裕時のみ）: 直前セッション結果、経験ログ抜粋
   - MVPは固定テンプレート（優先度1〜4のみ）

3. **セッション境界制御**: コンテキスト上限接近時 / 停滞検知時に強制終了
4. **ゴール間コンテキスト完全分離**（マルチゴール）
5. **ゴール間依存グラフ管理**（§9）:
   - 4種類: prerequisite / resource_conflict / synergy / conflict
   - 自動検出: LLMによる依存関係分析（confidence >= 0.8で自動登録）
   - スケジューリング影響: 前提条件未充足時のタスク生成抑制、リソース競合の直列化

**LLM要求**: 間接的（ゴール間依存の自動検出時）、コンテキスト組み立て自体はコードのみ

**依存**: StateManager（状態ファイル読み書き）、AdapterLayer（セッション起動）

**推定規模**: 大（クラス、4種セッションテンプレート、依存グラフ管理、永続化）

**MVP簡略化**: 優先度1〜4固定テンプレート、ゴール間依存グラフはPhase 2

---

### 2.2 GoalNegotiator（`goal-negotiation.md` + `goal-ethics.md`）

**役割**: ゴール受取→6ステップ交渉→合意済みゴールの状態ベクトル初期化。最も複雑なLayer 3モジュール。

**主要機能**:
1. **EthicsGate統合** (Step 0): LLM判定 → reject/flag/pass
2. **次元分解** (Step 2): LLMによるゴール→測定可能次元リストへの変換
3. **ベースライン観測** (Step 3): ObservationEngineを使った現在地確立
4. **実現可能性評価** (Step 4): 定量（変化率/能力/リソースの3チェック）+ 定性（LLM）のハイブリッド
5. **応答生成** (Step 5): 3種類（受諾A/カウンター提案B/要注意フラグC）
6. **再交渉** (§6): 停滞後/新情報/ユーザー要求の3トリガー
7. **サブゴール交渉** (§7): ゴールツリー各階層での個別交渉
8. **交渉ログ永続化** (§8): すべてのステップを記録

**feasibility_ratio判定**:
- `feasibility_ratio = gap / time / observed_rate`
- `<= 1.5`: 現実的 → 受諾
- `<= 2.5`: 挑戦的 → 受諾（character.md設定、デフォルト3.0から調整）
- `> 2.5`: 困難 → カウンター提案
- `realistic_target = 現在値 + (観測変化率 × 利用可能時間 × 1.3)` （係数1.3はcharacter.md設定）

**LLM要求**: **あり・多数**（倫理判定、次元分解、実現可能性定性評価、カウンター提案文生成）

**依存**: ObservationEngine（Step 3）、EthicsGate（Step 0）、StateManager、AdapterLayer

**推定規模**: 大（クラス、LLMプロンプト多数、サブゴール再帰、ログ永続化）

**実装上の注意**:
- EthicsGateは独立クラスとして分離し、GoalNegotiatorがcompose
- feasibility_ratioの閾値をcharacter.md設定として定数化（2.5）
- decompose()直後に全サブゴールのEthicsチェックを再実行

---

### 2.3 StrategyManager（`portfolio-management.md`）

**役割**: ゴールのギャップを埋める「戦略」を明示的エンティティとして管理。MVPは逐次実行。

**主要機能**:
1. **戦略の生成**: DriveScorer優先次元確定後にLLMが1〜2候補を生成
2. **状態遷移管理**: candidate→active→evaluating→suspended/completed/terminated
3. **タスク選択ルール**: 「最も待たされている戦略」から決定論的に選択
4. **効果計測**: 時系列相関（タスク完了タイミング × gap_delta）
5. **MVP: 手動リバランス（`motiva strategy switch`コマンド）**
6. **停滞連動**: StallDetector第2検知 → 戦略terminated + 新戦略生成

**Strategyデータモデル**（主要フィールド）:
```typescript
interface Strategy {
  id: string;
  goal_id: string;
  target_dimensions: string[];
  primary_dimension: string;
  hypothesis: string;
  expected_effect: { dimension: string; direction: "increase"|"decrease"; magnitude: "small"|"medium"|"large"; }[];
  resource_estimate: { sessions: number; duration: Duration; llm_calls: number|null; };
  state: "candidate"|"active"|"evaluating"|"suspended"|"completed"|"terminated";
  allocation: number;  // 0.0〜1.0
  gap_snapshot_at_start: number|null;
  effectiveness_score: number|null;
  consecutive_stall_count: number;
}
```

**LLM要求**: **あり**（戦略候補生成、LLM定性評価補助）

**依存**: DriveScorer（優先次元取得）、StallDetector（停滞連動）、StateManager

**推定規模**: 中（クラス、状態遷移、効果計測、ファイル永続化）

**MVP簡略化**:
- 同時active戦略は1つのみ
- LLMが1〜2候補生成、最上位を自動選択
- リバランスは手動
- WaitStrategyは`plateau_until`フィールド流用で簡易実装

---

## 3. Layer 4〜6 設計サマリー

### 3.1 TaskLifecycle（Layer 4、`task-lifecycle.md`）

**役割**: タスクの選択→生成→実行→検証→失敗対応の全フロー管理。

**主要機能**:
1. **タスク選択（コード）**: DriveScoreによる次元選択（LLM不使用）
2. **タスク生成（LLM）**: 作業内容、成功基準、スコープ境界、制約の具体化
3. **実行**: SessionManagerを通じてエージェントに委譲。不介入原則
4. **検証（3層）**: Layer 1（機械的・別セッション）、Layer 2（タスクレビュアー）、Layer 3（自己申告）
5. **失敗対応**: keep / discard（reversibleならリバート試行） / escalate
6. **倫理ゲートチェック（最優先）**: 実行前にEthicsGate.checkMeans()を呼ぶ（Phase 2）

**タスク構造の主要フィールド**（実装済み型に追加）:
- `strategy_id: string|null` — portfolio-management.mdで追加要求
- `estimated_duration: Duration|null`（設計済み、実装確認要）
- `reversibility: "reversible"|"irreversible"|"unknown"`（設計済み、実装確認要）
- `consecutive_failure_count: number`（設計済み）
- `plateau_until: DateTime|null`（設計済み）

**Layer 1 vs Layer 2の矛盾解消ルール**:
- L1 PASS + L2 FAIL → 再レビュー、それでもFAIL → FAIL
- L1 FAIL + L2 PASS → L1優先でFAIL

**LLM要求**: **あり**（タスク生成、reversibility判定、タスクレビュアー）

**依存**: DriveScorer、SessionManager、TrustManager、StrategyManager、EthicsGate（Phase 2）

**推定規模**: 大（クラス、3層検証、失敗対応フロー、リバートセッション起動）

---

### 3.2 CoreLoop（Layer 5、`mechanism.md` §2）

**役割**: observe→gap→score→task→execute→verifyの1ループ実行。全モジュールのオーケストレーター。

**フロー**:
```
DriveSystem.shouldActivate()
  → ObservationEngine.observe()
  → GapCalculator.calculate()
  → DriveScorer.scoreAllDimensions()
  → StrategyManager.selectStrategy()
  → TaskLifecycle.generateAndExecute()
  → SatisficingJudge.isGoalComplete()
  → StallDetector.checkStalls()
  → ReportingEngine（副作用）
```

**LLM要求**: 間接的（各サブモジュール経由）

**依存**: 全モジュール（Layer 0〜4全て）

**推定規模**: 中（クラス、シーケンス制御のみ。各ステップはサブモジュールに委譲）

---

### 3.3 ReportingEngine（Layer 5、`reporting.md`）

**役割**: 3種類のレポート生成とファイル配信。character.md §3軸4の実装先。

**レポート3種**:
1. **定期レポート**: 日次サマリー（standard） + 週次レポート（detailed）
2. **即時通知**: 緊急アラート / 承認要求 / 停滞エスカレーション（第3検知） / ゴール完了 / 能力不足
3. **戦略変更通知**: ピボット時に根拠付きで自動生成

**レポートモード**（character.md準拠）:
- 通常サマリー: 1〜2行（メトリクス変化+状態のみ）
- 詳細レポート: 停滞/エスカレーション/完了/ピボット/不可逆操作時

**LLMの役割分担**:
- コード: データ集計、トリガー評価、ファイル出力
- LLM: ナラティブ生成、戦略評価の言語化、リスク分析（standard以上のみ）

**MVP配信**: `~/.motiva/reports/` Markdownファイル + CLIログ（`motiva run`時）

**LLM要求**: **あり**（standardレベル以上のナラティブ生成）

**依存**: StateManager（全ゴール状態）

**推定規模**: 中（クラス、3種レポートテンプレート、クールダウン管理、ファイル出力）

---

### 3.4 CLIRunner（Layer 6、`mechanism.md` §5）

**役割**: `motiva run` コマンドエントリーポイント。CoreLoop + DriveSystem + ReportingEngineを組み合わせる。

**主要機能**:
- CLI引数パース
- DriveSystem起動チェック → CoreLoop実行 → ReportingEngine出力
- 未読レポート・未処理通知の表示
- `motiva strategy switch` 等のサブコマンド

**LLM要求**: なし（全LLM呼び出しはCoreLoop経由）

**依存**: CoreLoop、DriveSystem、ReportingEngine

**推定規模**: 小（エントリーポイント、引数パース）

---

## 4. Phase 2以降（MVP除外）

| モジュール | 設計書 | 理由 |
|-----------|-------|------|
| PortfolioManager | `portfolio-management.md` | 複数戦略並列実行、自動リバランス |
| CuriosityEngine | `curiosity.md` | メタ動機による新ゴール提案 |
| KnowledgeAcquirer | `knowledge-acquisition.md` | 知識不足検知・調査タスク・DomainKnowledge保存 |
| GoalDependencyGraph | `session-and-context.md` §9 | ゴール間依存の自動管理 |
| EthicsGate Layer 1 | `goal-ethics.md` §9 | カテゴリベースブロックリスト |
| TaskLifecycle倫理チェック | `goal-ethics.md` §5 | generateTask()後の手段チェック |
| DaemonRunner | `mechanism.md` §5 | 自動ループ実行（クーロン不要） |
| HTTPEventReceiver | `drive-system.md` | Phase 2イベント受信 |
| ExternalNotifier | `reporting.md` §5.2 | Slack/メール/Webhook配信 |
| CharacterCustomization | `character.md` §6 | 4軸パラメータ調整機能 |

---

## 5. 新規モジュール（元のLayer 0-6計画にない）

### EthicsGate（新規・GoalNegotiatorの一部またはサブモジュール）

元の設計計画（impl-roadmap-research.md）には存在しなかったが、最新コミットで追加。

- GoalNegotiatorに統合するか独立クラスにするかの選択が必要
- **推奨**: 独立クラス`EthicsGate`としてGoalNegotiatorがコンポーズする
- 永続化: `~/.motiva/ethics/ethics-log.json`
- MVPはLLM Layer 2のみ実装

---

## 6. LLM呼び出し一覧（全システム）

| モジュール | LLM呼び出しの目的 | MVP必須 |
|-----------|----------------|---------|
| EthicsGate | 倫理判定（Layer 2） | 必須 |
| GoalNegotiator | Step 2次元分解、Step 4定性評価、Step 5カウンター提案文 | 必須 |
| StrategyManager | 戦略候補生成（1〜2個） | 必須 |
| TaskLifecycle | タスク生成（作業内容・成功基準・スコープ）、reversibility判定 | 必須 |
| TaskLifecycle | タスクレビュアー（Layer 2独立セッション） | 必須 |
| ObservationEngine | ゴールレビュアー（Layer 2独立セッション） | 必須 |
| ReportingEngine | ナラティブ生成（standard/detailed） | 必須 |
| SatisficingJudge | 完了判断（定性評価の補助、Phase 2） | 任意 |
| DriveScorer | timing_bonus評価（デフォルト0.0でスキップ可） | 任意 |

**Anthropic SDK追加**: GoalNegotiatorで必須（Stage 3開始時にpackage.jsonへ追加）

---

## 7. 実装順序の推奨

```
Stage 3 (Layer 3):
  1. EthicsGate           — 独立クラス。GoalNegotiatorの前提
  2. SessionManager       — GoalNegotiatorの前提（ベースライン観測でセッション起動が必要）
  3. GoalNegotiator       — EthicsGate + SessionManager + ObservationEngine統合
  4. StrategyManager      — DriveScorer + StallDetector統合

Stage 4 (Layer 4):
  5. TaskLifecycle        — 最複雑。全Layer 3 + TrustManager + SessionManager統合

Stage 5 (Layer 5):
  6. ReportingEngine      — StateManagerのみ依存。比較的独立
  7. CoreLoop             — 全モジュール統合

Stage 6 (Layer 6):
  8. CLIRunner            — CoreLoop + DriveSystem + ReportingEngine
```

---

## 8. 横断的な設計判断（実装前に確定が必要）

### 8.1 EthicsGateの配置

**選択肢A**: GoalNegotiator内のprivateメソッド群として実装
**選択肢B**: 独立クラス`EthicsGate`として実装し、GoalNegotiatorがコンポーズ

推奨: B。TaskLifecycle（Phase 2でgenerateTask()後の手段チェック）でも使用するため、独立クラスの方が再利用性が高い。

### 8.2 characterパラメータの配置

feasibility_ratio閾値（2.5）とrealistic_target係数（1.3）はGoalNegotiatorの設定定数として保持。
ReportingEngineのモード分類はReportingEngineの設定として保持。
将来のカスタマイズに備え、`CharacterConfig`型として定義することを推奨。

### 8.3 progress_ceiling数値の不整合

- `observation.md`: self_report→0.70、independent_review→0.90
- `satisficing.md`: low→0.60、medium→0.85

**解決方針**: observation.mdの数値（0.70/0.90）を正として統一。satisficing.mdは完了判断コンテキストでの意図的な厳格化として解釈する場合のみ0.60/0.85を採用。实装前に確定が必要（**Uncertain**）。

### 8.4 strategy_idのタスクへの追加

`portfolio-management.md` §8.2がTask型に`strategy_id: string|null`フィールドの追加を要求。
既存の`src/types/task.ts`に追加が必要。

---

## 9. ファイルレイアウト（新規）

Stage 3以降で追加されるファイルパス:

```
~/.motiva/
├── ethics/
│   └── ethics-log.jsonl     # EthicsGate判定ログ
├── goals/<goal_id>/
│   └── negotiation-log.json # GoalNegotiator交渉ログ
├── strategies/<goal_id>/
│   ├── current-strategy.json
│   └── strategy-history.json
└── reports/
    ├── daily/
    ├── weekly/
    └── notifications/
```

---

## 10. 信頼ラベル

| 情報 | ラベル |
|------|------|
| EthicsGate設計詳細（goal-ethics.md） | **Confirmed** |
| GoalNegotiator 6ステップフロー | **Confirmed** |
| StrategyManager MVP仕様（逐次実行、手動リバランス） | **Confirmed** |
| SessionManager コンテキスト選択アルゴリズム | **Confirmed** |
| TaskLifecycle 3層検証・矛盾解消ルール | **Confirmed** |
| ReportingEngine LLM/コード役割分担 | **Confirmed** |
| progress_ceiling数値の不整合 | **Uncertain**（要確定） |
| EthicsGate独立クラス推奨 | **Likely** |
| Phase 2モジュール一覧 | **Confirmed** |
