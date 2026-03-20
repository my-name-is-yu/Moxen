# TUI UX 改善 Issue リスト

作成日: 2026-03-19
対象: src/tui/ 全11ファイルの分析結果

---

## 1. TUI: ダッシュボードに現在のタスク実行状況が表示されない

ダッシュボードは次元の進捗バーと trust スコアのみ表示しており、「今どのタスクを実行中か」「何番目のイテレーションか」「経過時間」といったリアルタイム実行情報が欠如している。`LoopState` には `iteration`・`startedAt`・`lastResult` が含まれているにもかかわらず、Dashboard コンポーネントに渡されていない。現在のタスク名と開始からの経過時間をダッシュボードに追加すると、ユーザーは「Motivaが今何をしているか」を一目で把握できる。

**Labels**: `enhancement`, `tui`, `ux`

---

## 2. TUI: ループ実行中のスピナー・アニメーションがない

`use-loop.ts` のポーリング間隔は2秒だが、その間ダッシュボードは静止したまま。`status: "running"` のときにダッシュボードヘッダーやステータスバーに `ink-spinner` を表示する仕組みがない。ユーザーはアプリがフリーズしているのか動いているのか判断できず、不安を覚える。実行中は ` [spinner] running` のように動きのあるフィードバックを提供すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `visual-polish`

---

## 3. TUI: チャット履歴をスクロールできない（過去メッセージに戻れない）

`chat.tsx` では `visibleCount = termRows - 12` 行分しか表示せず、古いメッセージは `↑ N earlier messages` というテキストインジケーターで示されるだけで実際には遡れない。`MAX_MESSAGES = 200` の制限があるにもかかわらず、スクロールアップ操作（例: Page Up / Ctrl-U）が実装されていない。長い会話やエラー調査時に過去の出力を確認できないため、デバッグ体験が著しく低下する。

**Labels**: `enhancement`, `tui`, `ux`, `chat`

---

## 4. TUI: markdown-renderer がインライン書式（太字・コード）を完全に消去する

`markdown-renderer.ts` の `stripInlineMarkdown()` は `**bold**` や `` `code` `` を単純にテキストに変換し、Ink の `<Text bold>` や `<Text color="cyan">` へのマッピングを行っていない。`MarkdownLine` インターフェースには `bold`・`italic` フィールドが定義されているが、ヘッダー（`#`）以外では使われていない。LLM が返す応答内の強調やコード片が見た目上フラットになり、情報の視覚的な階層が失われる。

**Labels**: `enhancement`, `tui`, `ux`, `markdown`

---

## 5. TUI: /status コマンドの出力がチャット形式で読みにくい

`actions.ts` の `handleStatus()` は複数の文字列を `messages[]` 配列で返すため、各次元が1行1行バラバラに表示される。ダッシュボードが横にある場合は情報が重複し、ダッシュボードがない（狭い端末）場合はテーブル形式なしで一覧が流れるだけになる。`/status` は ReportView 形式（ボーダー付きオーバーレイ）で表示するか、ダッシュボードと同等の進捗バー付きフォーマットで返すべきである。

**Labels**: `enhancement`, `tui`, `ux`

---

## 6. TUI: 承認オーバーレイにタスクの影響範囲・アダプター情報が表示されない

`approval-overlay.tsx` は `work_description`・`rationale`・`reversibility` の3フィールドのみ表示する。`Task` 型にはこれ以外にも `adapter_id`・`expected_outcome`・`constraints` など意思決定に必要な情報が含まれている可能性が高い。不可逆なタスクの承認は特に慎重さが要求されるため、どのアダプター（例: claude-code-cli）が何に対して実行するかを明示する必要がある。`reversibility === "irreversible"` の場合は赤背景の警告帯を追加することも検討すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `safety`

---

## 7. TUI: ステータスバーの `status` 値がそのままの英語文字列で表示される

`app.tsx` の `StatusBar` は `loopState.status` を `"running"`, `"idle"`, `"stalled"` 等のまま表示する。これらは内部の enum 値であり、`"max_iterations"` のような値はユーザーフレンドリーではない。また色付けもなく、`statusColor()` 関数が dashboard.tsx にあるにもかかわらず StatusBar では使われていない。StatusBar の status 表示にも色付けを適用し、`"max_iterations"` → `"limit reached"` のように人間が読みやすいラベルに変換すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `visual-polish`

---

## 8. TUI: ゴール作成フロー（goal negotiate）の進捗が全く見えない

`handleGoalCreate()` は `goalNegotiator.negotiate()` を await するが、この処理は LLM 呼び出しを含み数秒〜十数秒かかる。その間 `isProcessing = true` でチャット入力がブロックされ、スピナーは `"Thinking..."` のまま。ゴール交渉は `observe → decompose → evaluate` のフェーズを経るが、TUI にはフェーズ名も進捗インジケーターも表示されない。`"Negotiating goal... (this may take 10-30 seconds)"` のような具体的なフィードバックを出すだけでも体験が大きく改善される。

**Labels**: `enhancement`, `tui`, `ux`, `loading-state`

---

## 9. TUI: ヘルプオーバーレイに重要なコマンドが不足している

`help-overlay.tsx` に `/goals` のようなコマンドは記載されているが、`/run <number>`（複数ゴール時の番号指定）・自然言語でのゴール作成方法・`/report` で表示される内容の説明がない。また `KEYBOARD SHORTCUTS` セクションに `F1` キー（toggle help）が記載されていない。ヘルプが不完全だと、ユーザーは機能に気づかないまま使い続けることになる。

**Labels**: `enhancement`, `tui`, `ux`, `help`

---

## 10. TUI: レポートビューが長いコンテンツでスクロールできない

`report-view.tsx` はレポートを静的に描画するだけで、スクロール機能がない。長い `weekly_report` や `execution_summary` は端末の高さを超えてもスクロールアップできず、下部が見切れたまま消える。また閉じ方が `"任意のキーで閉じる"` という暗黙の動作（`app.tsx` の `handleInput` 冒頭で `reportToShow !== null` の場合に dismiss）であり、閉じ方を示す UI ヒントがない。フッターに `ESC / any key to dismiss` の常時表示を追加すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `report`

---

## 11. TUI: エラーメッセージが赤テキストのみで構造化されていない

`app.tsx` の catch ブロックは `Error: ${message}` をそのまま chat に流す。また `dashboard.tsx` のエラー表示も `Error: {state.lastError}` の1行のみ。スタックトレースや発生コンテキスト（どのイテレーション・どのゴール）が失われるため、デバッグに役立たない。エラーには「何が失敗したか」「ユーザーが取れる次のアクション」（例: `Try /status to check goal state`）を添えた構造化フォーマットで表示すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `error-handling`

---

## 12. TUI: 狭い端末（< 80 列）でサイドバーが消えたことがユーザーに伝わらない

`app.tsx` では `termCols < 80` のとき `showSidebar = false` でダッシュボードを非表示にする。しかし何のメッセージも表示されないため、ユーザーは次元進捗が見えないことに気づかない可能性がある。また TUI 全体の最小推奨幅が何列なのかも不明確。サイドバーが非表示の場合、チャット上部に `[narrow mode: resize to 80+ cols for dashboard]` などの通知を1行表示すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `responsive`

---

## 13. TUI: コマンドオートコンプリートが起動直後は `/` を入力するまで表示されない（発見可能性の低さ）

`chat.tsx` のオートコンプリートは `input.startsWith('/')` のときのみ起動する。初回ユーザーは `/` があることを知らなければコマンド体系に気づかない。ウェルカムメッセージは `Type '/help' for available commands` と記載しているが、インタラクティブなヒントとして入力欄に `Try /help to get started` のようなプレースホルダーテキストを表示すると発見可能性が高まる（`ink-text-input` の `placeholder` prop を利用）。

**Labels**: `enhancement`, `tui`, `ux`, `discoverability`

---

## 14. TUI: ループ完了時（goal_completion）の祝福・フィードバックがない

`use-loop.ts` でループが `"completed"` になるとダッシュボードが更新されるが、チャットには何も流れてこない。`reportingEngine` は `goal_completion` レポートを生成できるが、TUI はそれを自動で表示しない。ゴール達成という重要なイベントが静かに通り過ぎてしまい、ユーザー体験として大きな喪失感がある。ループが `"completed"` になった瞬間に `ReportView` または成功メッセージをチャットに自動表示すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `feedback`

---

## 15. TUI: 起動時のローディング状態が表示されない（buildDeps の待機中）

`entry.ts` の `buildDeps()` は LLM クライアント初期化・characterConfig ロード等を含み、数秒かかる可能性がある。この間、端末は空白のままで Ink は何もレンダリングしていない。ユーザーにはアプリが起動しているかどうかすらわからない。Ink のレンダリング前に `console.log("Starting Motiva...")` を出すか、最小限のスプラッシュ画面（`render(<LoadingScreen />)` → deps 完了後に `<App />` に切り替え）を実装すべきである。

**Labels**: `enhancement`, `tui`, `ux`, `loading-state`

---

## 優先度サマリー

| # | タイトル（短縮） | 影響度 | 実装コスト |
|---|-----------------|--------|-----------|
| 3 | チャット履歴スクロール不可 | 高 | 中 |
| 8 | ゴール作成進捗フィードバック不足 | 高 | 低 |
| 14 | ループ完了時の祝福なし | 高 | 低 |
| 4 | markdown インライン書式が失われる | 中 | 中 |
| 1 | ダッシュボードに実行中タスクが表示されない | 中 | 低 |
| 2 | 実行中スピナーなし | 中 | 低 |
| 6 | 承認オーバーレイの情報不足 | 中（安全性） | 低 |
| 15 | 起動時ローディング状態なし | 中 | 低 |
| 7 | ステータスバーの status 文字列 | 低 | 低 |
| 13 | コマンド発見可能性（placeholder） | 低 | 低 |
| 5 | /status 出力のフォーマット | 低 | 中 |
| 9 | ヘルプ内容の不完全さ | 低 | 低 |
| 10 | レポートビューのスクロール不可 | 低 | 中 |
| 11 | エラーメッセージの構造化不足 | 低 | 低 |
| 12 | 狭い端末での非表示通知なし | 低 | 低 |
