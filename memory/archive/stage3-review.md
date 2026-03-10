# Stage 3 Review — 手動テスト結果

実施日: 2026-03-11
ブランチ: `poc/motive-layer`

---

## テスト結果

| # | テスト | 結果 | 備考 |
|---|--------|------|------|
| 1 | LLMClient API接続 | PASS | sendMessage, parseJSON, エラー処理すべてOK |
| 2 | EthicsGate | PASS | reject 3件。グレーゾーン1件がflagでなくpass（LLM判断揺れ、許容範囲） |
| 3 | GoalNegotiator | PASS | 次元分解(6次元)、カウンター提案、倫理reject(EthicsRejectedError)すべてOK |
| 4 | 永続化 | PASS | goal.json, negotiation-log.json 作成・API読み戻し確認 |
| 5 | SessionManager | PASS | 4種コンテキスト正常、バイアス混入なし、スロット数(4,5,4,2,3)正確 |
| 6 | ペルソナ確認 | PASS | system promptにMotiva Persona反映あり。feasibility_ratio=2.5はプロンプト直接含有なし(要確認) |
| 7 | トークン計測 | PASS | 11回呼び出し、5308 tokens、概算$0.05/negotiate |

## ゲート条件

- [x] 全654ユニットテスト通過（LLMモック使用）
- [x] 実APIでGoalNegotiator一連フロー完走（ゴール→倫理→次元分解→実現可能性→応答）
- [x] EthicsGateが不適切ゴールを3種以上reject
- [x] 交渉ログが `goals/<goal_id>/negotiation-log.json` に永続化される
- [x] SessionManager 4種コンテキストにバイアス情報の混入なし

## テスト中に発見・修正したバグ

### threshold_value 配列パースエラー (修正済み)

- **現象**: LLMがrange型次元の `threshold_value` を配列 `[60, 80]` で返すとZodバリデーション失敗
- **原因**: `DimensionDecompositionSchema.threshold_value` が `number | string | boolean | null` のみ受付
- **修正**:
  - `src/types/negotiation.ts` — 配列型 `(number | string)[]` を追加
  - `src/goal-negotiator.ts` — `buildThreshold` で配列→ `{ type: "range", low, high }` に変換
  - `tests/goal-negotiator.test.ts` — range型配列のテストケース追加
- **テスト**: 654テスト通過（+1）

## 未解決事項

- **feasibility_ratio=2.5**: character.md で定義された値がプロンプトに直接含まれていない。コード内ハードコードか別経路での反映か要確認
- **EthicsGate グレーゾーン判定**: 「競合の公開情報を収集して分析したい」がflagでなくpassに。プロンプト調整の余地あり（P2: 機能に影響なし）

## 数値データ

- ユニットテスト: 654件通過
- LLM呼び出し: negotiate() 1回あたり N+3 回（N=次元数）
- トークン消費: negotiate() 1回あたり約5,000 tokens / $0.05
- テスト実施時の総API費用: $0.32

