# Phase 3: 開発基盤整備計画

## 背景
Phase 1-2でsrc/リストラクチャリング完了（45ファイル移動 + 4大ファイル分割）。
今後の開発コスト削減のため、残りの大ファイル分割・モジュールマップ整備・テスト効率化を行う。

## 柱1: ファイル分割（高優先5ファイル）

### Phase 3a: core-loop.ts (1395行)
- tree-loop-runner.ts 抽出（runTreeIteration + runMultiGoalIteration, ~330行）
- core-loop-types.ts 抽出（全interfaces/types, ~190行）
- core-loop.ts → ~875行

### Phase 3b: task-lifecycle.ts (1313行)
- task-verifier.ts 抽出（verifyTask + handleVerdict + handleFailure, ~370行）
- task-lifecycle.ts → ~600行
- 注: task-prompt-builder.ts, task-health-check.tsはPhase 2で抽出済み

### Phase 3c: goal-tree-manager.ts (1181行)
- goal-tree-pruner.ts 抽出（pruneGoal, pruneSubgoal, getPruneHistory, ~200行）
- goal-tree-quality.ts 抽出（scoreConcreteness, evaluateDecompositionQuality, ~360行）
- goal-tree-manager.ts → ~620行

### Phase 3d: goal-negotiator.ts (1172行)
- goal-decomposer.ts 抽出（decompose + decomposeIntoSubgoals, ~390行）
- goal-negotiator.ts → ~450行
- 注: goal-suggest.ts, goal-validation.tsはPhase 2で抽出済み

### Phase 3e: memory-lifecycle.ts (1165行)
- memory-compression.ts 抽出（compressToLongTerm + applyRetentionPolicy + runGarbageCollection, ~380行）
- memory-selection.ts 抽出（selectForWorkingMemory + relevanceScore, ~260行）
- memory-lifecycle.ts → ~525行
- 注: drive-score-adapter.ts, memory-phases.ts, memory-persistence.tsはPhase 2で抽出済み

### 追加: portfolio-manager.ts移動
- src/portfolio-manager.ts (847行) → src/strategy/portfolio-manager.ts

## 柱1 中優先（Phase 3f以降、必要に応じて実施）

| ファイル | 行数 | 分割案 | 目標行数 |
|---|---|---|---|
| learning-pipeline.ts | 1032 | cross-goal + feedback抽出 | ~350 |
| curiosity-engine.ts | 974 | proposals + transfer抽出 | ~540 |
| cross-goal-portfolio.ts | 944 | scheduling + allocation抽出 | ~315 |
| memory-phases.ts | 739 | index/stats/query/distill 4分割 | ~150各 |
| capability-detector.ts | 736 | registry + dependencies抽出 | ~360 |
| knowledge-manager.ts | 743 | search + revalidation抽出 | ~480 |

## 柱1 低優先

| ファイル | 行数 | 分割案 | 目標行数 |
|---|---|---|---|
| satisficing-judge.ts | 725 | tree-completion抽出 | ~505 |
| ethics-gate.ts | 680 | rules定数抽出 | ~280 |
| knowledge-transfer.ts | 654 | borderline | - |
| cli/commands/suggest.ts | 654 | context-gatherer抽出 | ~250 |

## 柱2: モジュール境界マップ

`docs/module-map.md` に全モジュールの責務・入出力・依存関係を記載。
CLAUDE.mdからは参照のみ（「docs/module-map.mdにモジュール境界マップあり」）。
目的: Claudeが「どのファイルを触るべきか」を即判断でき、Glob/Grep探索を削減。

## 柱3: テスト効率化

- vitest --changed 対応（リファクタ時は影響テストのみ実行）
- テストグループ分け検討（unit / integration / e2e）
- 現状: 3431テスト × 7分 → リファクタ系では過剰
