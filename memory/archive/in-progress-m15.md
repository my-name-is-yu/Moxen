# In Progress: TUI改善 (Issues #76-#84)

## 現在地
Critical 3件 (C1-C3) 修正済み・コミット済み (b40488e)。Important 9件を issue 化済み。

## 完了
- **C1**: `app.tsx` — handleInput に try/catch/finally 追加（無限スピナー修正）
- **C2**: `entry.ts` — 承認リクエストキュー追加（レース条件修正）
- **C3**: `use-loop.ts` — useEffect cleanup に controller.stop() 追加（インターバルリーク修正）

## 未着手 Issues（優先度順）
- **#80 (I5)**: entry.ts の依存構築が CLIRunner と乖離（contextProvider 未注入）⚠️ 最優先
- **#76 (I1)**: ターミナルリサイズ未対応でレイアウト崩れ
- **#77 (I2)**: チャットメッセージの key={i} で React diffing 壊れ
- **#78 (I3)**: ステータス表示で count 型 dimension も ×100 して異常値表示
- **#79 (I4)**: コマンドオートコンプリートがキーボード選択不可
- **#81 (I6)**: エラーメッセージ分類が文字列 prefix 依存で脆弱
- **#82 (I7)**: report-view.tsx が実装済みだが未使用
- **#83 (I8)**: ラベル切り詰めがハードコードで狭い端末で溢れる
- **#84 (I9)**: マルチゴール未対応（最初のゴールのみ実行可能）

## 次のステップ
#80 (I5) から順に着手
