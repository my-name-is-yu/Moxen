# In-Progress: R4 — CLI安定化

## 背景
R1-R3完了、2900テスト全パス（72ファイル）。Fix-A（DataSource自動登録）、Fix-B（contextProvider外部ファイル）、`--yes`カウンター提案バグ修正完了。dogfooding検証済み。

## 修正対象（docs/roadmap2roadmap.md R4セクション参照）

### R4-1: エントリポイントの修正（S）
- `dist/cli-runner.js` にシバン確認
- `npm link` で `motiva` コマンド動作確認
- CI追加は任意

### R4-2: フラグ解析の修正（S）
- `--yes` が位置引数の前に来ると無視される問題
- `motiva --yes run --goal <id>` と `motiva run --goal <id> --yes` の両方が動くこと
- 注: `goal add --yes` のカウンター提案自動承認は修正済み（2026-03-16）

### R4-3: file_existenceタイプのCLI対応 ✅ 修正済み

### R4-4: コマンド出力の改善（M）
- 全サブコマンドの正常終了時に確認メッセージ出力
- `motiva run` の進捗表示（イテレーション番号、gap値等）
- エラー時のメッセージ改善

### R4-5: 環境変数バリデーションの早期実行（S）
- `buildLLMClient()` でAPIキー存在を即座に検証
- 未設定時に設定方法を含むエラーメッセージ表示

## 実行順序
1. R4-1, R4-2, R4-5 は独立・並行可能（全てSmall）
2. R4-4（Medium）は最後
3. 全テスト確認
4. dogfooding再実行

## テスト状態
- 72ファイル、2900テスト全パス
- ビルド: `npm run build` 成功
