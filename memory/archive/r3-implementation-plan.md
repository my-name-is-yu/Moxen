# R3 Implementation Plan
**作成日**: 2026-03-16
**依存**: R1完了（CoreLoop短絡修正済み）、R2完了（contextProvider + observeWithLLM改善済み）

---

## R3-1: タスク生成プロンプトの検証と改善

### 現状

**ファイル**: `src/task-lifecycle.ts` L904-1027

`buildTaskGenerationPrompt()` に現在含まれるもの:
- ゴールタイトル + 説明 (L916-923)
- 対象次元の現在値と目標値 (L925-949)
- リポジトリ context（package.json の name + description）(L970-992)
- アダプタ種別に応じた実行コンテキスト (L951-964)
- ドメイン知識 (knowledgeContext) (L966-968)
- 既存タスクリスト（重複防止）(L994-996)

**欠けているもの**:
1. **ワークスペース状態**: `contextProvider` はObservationEngineに注入されているが、TaskLifecycle には DI されていない。buildTaskGenerationPrompt はファイル内容を一切読まない
   - ObservationEngineは `contextProvider: (goalId, dimName) => Promise<string>` を受け取る（R2-1で実装済み、`src/context-providers/workspace-context.ts`）
   - TaskLifecycle に同じ contextProvider を注入するパスが存在しない
2. **次元の「ギャップ」情報**: 現在値と閾値は入っているが、「閾値まであとどれだけか」の差分計算がない
3. **過去タスクの結果**: existingTasks は open タスクのタイトル一覧のみ。完了済みタスクの verdict（何が試されて失敗したか）がない

### 必要な変更

1. **TaskLifecycle コンストラクタに `contextProvider` オプションを追加**
   - 型: `((goalId: string, dimensionName: string) => Promise<string>) | undefined`
   - `src/task-lifecycle.ts` コンストラクタ（L約80-130付近）に追加
   - `src/cli-runner.ts` の TaskLifecycle 初期化箇所で注入（ObservationEngineに渡しているものを共有）

2. **buildTaskGenerationPrompt をasync化してワークスペース状態を注入**
   - メソッドシグネチャ変更: `private async buildTaskGenerationPrompt(...)`
   - `contextProvider` を呼び出して `workspaceContext` を取得し、プロンプトに追加
   - generateTask() も async なので呼び出し側の変更は最小

3. **プロンプトの末尾に出力形式の制約を強化**（roadmap2roadmap.md R3-1の方針通り）:
   ```
   work_description には以下を含めること:
   1. 変更対象のファイルパス（相対パス）
   2. 具体的な変更内容（「改善する」ではなく「セクションXを追加する」）
   3. 完了判定基準（ファイル存在 or 内容チェック）
   ```

### 影響ファイル
- `src/task-lifecycle.ts`: コンストラクタ（L約80-130）、buildTaskGenerationPrompt（L904-1027）
- `src/cli-runner.ts`: TaskLifecycle 初期化箇所で contextProvider 注入

---

## R3-2: アダプタ実行の実証テスト

### 現状

**ClaudeCodeCLIAdapter** (`src/adapters/claude-code-cli.ts` L32-113):
- `claude --print` を spawn し、プロンプトを stdin に書き込む
- exit code 0 = success、それ以外は error
- TODOコメントあり: 「--print flag が実際の claude CLI で動くか未検証」(L36)
- workDir オプションあり（cwd 設定用）

**OpenAICodexCLIAdapter** (`src/adapters/openai-codex.ts` L43-134):
- `codex exec [--full-auto] [--model <model>] "PROMPT"` を spawn
- プロンプトは **stdin ではなく positional argument** として渡す（L59）
- stdin は即座に close (L84)
- TODOコメントあり: 「CLI flagsの検証未完了」(L10-15)

**両アダプタ共通**:
- AgentTask.prompt を受け取る（型: string）
- AgentTask.timeout_ms でタイムアウト管理
- AgentResult を返す（success: bool, output: string, error: string|null, exit_code: number|null）

### テスト設計

**テストファイル**: `tests/e2e/r3-adapter-execution.test.ts`（新規）

シナリオ:
1. **前提確認テスト**: `which claude` or `which codex` で CLI が存在するか確認。なければスキップ
2. **最小実行テスト**: `/tmp/motiva-test/` ディレクトリに `hello.txt` を作成する
   - タスクプロンプト: `"Create a file at /tmp/motiva-test/hello.txt with the content 'hello from motiva test'"`
   - AgentTask.timeout_ms = 120_000（2分）
   - 実行後に `fs.existsSync('/tmp/motiva-test/hello.txt')` で確認
3. **失敗ケース**: 不正なプロンプトで error が返ることを確認

**注意点**:
- claude CLI の `--print` フラグが実際に非インタラクティブで動くか確認が必要
- codex CLI の正確な subcommand/flag syntax が変更されている可能性（TODOコメント通り）
- テストは `MOTIVA_RUN_ADAPTER_E2E=true` 環境変数が設定されている場合のみ実行（CI では skip）

### 影響ファイル
- `tests/e2e/r3-adapter-execution.test.ts`（新規）
- CLI flags 修正が必要な場合: `src/adapters/claude-code-cli.ts`（L38）、`src/adapters/openai-codex.ts`（L48-59）

---

## R3-3: タスク実行後の観測フィードバック検証

### 現状

**verifyTask** (`src/task-lifecycle.ts` L385-577):
- 3層検証: L1（機械的）→ L2（LLM）
- L1機械的検証: success_criteriaの verification_method が `npm`, `bash`, `test -f` 等で始まる場合のみ実行可能（L1036-1042）
- dimension_updates の計算（L522-558）:
  - verdict=pass: `+0.4`（固定デルタ）
  - verdict=partial: `+0.15`（固定デルタ）
  - verdict=fail: `[]`（更新なし）
  - `new_value = Math.min(1, Math.max(0, prevVal + progressDelta))`

**dimension_updates の反映** (L607-638):
- `stateManager.readRaw('goals/${goalId}.json')` で現在のゴール状態を読み込み
- `dimension_updates` にマッチする次元の `current_value` を上書き
- partial の場合も `isDirectionCorrect()` が true なら反映

**問題点**:
1. **固定デルタ方式**: `+0.4` / `+0.15` はタスク内容に関係なく適用される。実際のファイル変更内容を観測した値（R2のLLM観測）が使われない
2. **再観測が呼ばれない**: verifyTask → handleVerdict の後、CoreLoop が次のイテレーションで observe() を呼ぶ。これは正しい設計だが、「タスク実行→即座の再観測でスコアが変化するか」のE2Eパスが未検証
3. **`test -f` などの機械的検証**: L1 が applicable になる条件が狭い（prefixリスト L1036）。`test -f FILE` はリストにないので適用外になる可能性

**フィードバックループの設計**:
```
runTaskCycle() 内:
  1. generateTask() → Task生成
  2. executeTask() → AdapterResult
  3. verifyTask() → VerificationResult（dimension_updates含む）
  4. handleVerdict() → 次元値をgoal stateに書き込み
  5. return (action, task, verificationResult)

次のCoreLoop iteration:
  6. observe() → 再観測（contextProvider経由でファイル内容を読む）
  7. gapCalculator → gap再計算
  8. is_complete 判定
```
このフローは設計上は正しい。R3-3 の目的は「このパスが実際に動く」ことをE2Eテストで証明すること。

### テスト設計

**テストファイル**: `tests/e2e/r3-feedback-loop.test.ts`（新規）

シナリオ（モックアダプタ使用でも可）:
1. `/tmp/motiva-r3/` に空のゴール状態を作る
2. `file_exists` 次元（0.0 → threshold 1.0）のゴールを設定
3. タスクを生成・実行（FileExistenceDataSourceAdapter で観測可能なファイルを作成するアダプタ）
4. verifyTask() が dimension_updates を返すことを確認
5. handleVerdict() 後に goal state の dimension.current_value が更新されることを確認
6. 次回 observe() でファイル存在が検出されてスコアが 1.0 になることを確認

**確認すべき問題**:
- `test -f FILE` が L1 mechanical prefix リストに入っていないため、機械的検証が skip される → `sh` か `bash -c "test -f FILE"` に変更が必要か

### 影響ファイル
- `src/task-lifecycle.ts`: L1036 の mechanicalPrefixes に `"test "` 追加を検討
- `tests/e2e/r3-feedback-loop.test.ts`（新規）

---

## R3-4: ゴール交渉の次元品質改善（未完了部分）

### 現状

**部分修正済み**（roadmap2roadmap.md §R3-4より）:
- commit eab1bdf: `findBestDimensionMatch` 閾値 0.3 → 0.6 (`src/goal-negotiator.ts` L1234付近)
- commit 1bcb8db: プロンプト軟化 — `CRITICAL CONSTRAINT` を残しつつ「品質次元も追加せよ」の指示を追記（L61-66）

**現在のプロンプト** (L61-66):
```
CRITICAL CONSTRAINT: For dimensions that overlap with the available data sources below, you MUST use those exact dimension names so mechanical measurements can be wired automatically. However, you SHOULD ALSO add additional quality-oriented and semantic dimensions that directly reflect the goal description...
```

**post-process リマッピング** (L439-451):
- LLMが返した次元名について、DataSource次元名に70%以上のトークンオーバーラップがあれば強制リネーム
- この後、**バリデーションなし** — 全次元がDataSource次元名になっていても警告が出ない

**未完了: 警告メッセージのバリデーション**
- 場所: `src/goal-negotiator.ts` L451-456付近（post-processループの直後）
- 必要な実装:
  ```typescript
  // Post-process後の全次元チェック
  const allAreDsNames = dimensions.every(d => allDsNames.includes(d.name));
  if (allAreDsNames && dimensions.length > 0) {
    console.warn(
      "[GoalNegotiator] WARNING: All dimensions mapped to DataSource names. " +
      "Quality/semantic dimensions may have been suppressed. " +
      `Dimensions: ${dimensions.map(d => d.name).join(', ')}`
    );
  }
  ```
- 同じ警告が renegotiate() の post-process (L808-817) にも必要

### 影響ファイル
- `src/goal-negotiator.ts`: L451付近（negotiate()のpost-process後）、L817付近（renegotiate()のpost-process後）

---

## サブタスク間の依存関係

```
R3-1 (プロンプト改善)
  → contextProvider を TaskLifecycle に注入（R2-1の成果を活用）
  → R3-2, R3-3 の E2E テストの前提（品質の高いタスク生成が必要）

R3-2 (アダプタ実証テスト)
  → R3-3 の前提（アダプタが実際に動くことを確認してから feedback loop を検証）
  → 独立して先行着手可能

R3-3 (フィードバック検証)
  → R3-1 + R3-2 の完了が望ましい
  → verifyTask の dimension_updates + CoreLoop 再観測の連携確認

R3-4 (警告バリデーション)
  → 完全独立。いつでも着手可能（1-2時間の作業）
```

## 推奨実装順序

1. **R3-4** (独立・小規模): goal-negotiator.ts の2箇所に警告バリデーション追加（Sサイズ）
2. **R3-2** (先行着手): アダプタ実証テスト作成。CLI flags の実際の動作を確認（Mサイズ）
3. **R3-1** (R2の成果活用): contextProvider を TaskLifecycle に DI し、プロンプト強化（Mサイズ）
4. **R3-3** (統合検証): dimension_updates → goal state → 再観測の一気通貫 E2E テスト（Lサイズ）

## 重要な発見事項

1. **contextProvider が TaskLifecycle に未注入**: R2-1 で workspace-context.ts が実装されたが、ObservationEngine にのみ注入されており TaskLifecycle は知らない。R3-1 の最重要修正点。

2. **dimension_updates は固定デルタ方式**: pass=+0.4, partial=+0.15 がハードコードされている。R2 の LLM 観測結果（実際のスコア）は次のイテレーションの observe() で初めて反映される。この設計は意図的だが、documentation が薄い。

3. **アダプタの CLI flags に TODO コメント**: 両アダプタとも「実際の CLI バージョンで動くか未検証」の TODO が残る。R3-2 はこの検証が主目的。

4. **test -f が L1 機械的検証の prefix リストにない**: success_criteria で `test -f README.md` を使う場合、L1 verification が skip される。`sh -c "test -f ..."` に変えるか prefix リストに `"test "` を追加する必要がある。

5. **R3-4 の警告は L451 の直後**: post-process リマッピングループが閉じた直後に追加するだけ。negotiate() と renegotiate() の2箇所で同じパターンを繰り返す。
