# In-Progress

## 現在: Milestone 13 完了

### 今セッション完了
- **plugin CLI**: 実装済み確認（11テスト全パス）
- **M13.1**: CapabilityDetector拡張 — matchPluginsForGoal() + detectGoalCapabilityGap suggestedPlugins (98テスト)
- **M13.2**: プラグイン信頼スコア学習 — recordPluginSuccess/Failure + selectPlugin (86テスト)
- **M13.3**: スキップ（searchKnowledge/searchAcrossGoals既に実装済み）
- **M13.4**: 動的バジェットコンテキスト — createSessionにconflict-aware wiring (108テスト)
- **M13.5**: CuriosityEngine埋め込みベース検出 — indexDimensionToVector + findSimilarDimensions (168テスト)

### 未解決・要観察
- サブゴール品質（tree mode）→ 未再検証
- GitHub Issueゴール — GitHubIssueAdapter検証未実施
- タスク品質改善（LLMプロンプト）→ 未着手

### 次のステップ
- M13 Dogfooding検証
- Milestone 14以降の計画（`docs/roadmap-m8-beyond.md` §将来）
