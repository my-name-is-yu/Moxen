# Milestone 6 — 能力自律調達 Phase 2: Research Findings

_Research date: 2026-03-16_

---

## 1. スコープ再確認

- **M6.1**: Full cycle capability acquisition — detect → acquire (agent delegation) → verify → register
- **M6.2**: Dynamic Capability Registry — hot-plug adapters/datasources, dependency management

---

## 2. 現状の実装サマリ (What Exists)

### 2.1 CapabilityDetector (`src/capability-detector.ts`)

| メソッド | 状態 | 説明 |
|---------|------|------|
| `detectDeficiency(task)` | 実装済み | タスクレベルの能力不足をLLMで検出 |
| `detectGoalCapabilityGap(goal, adapterCaps)` | 実装済み | ゴールレベルの能力ギャップ検出（acquirableフラグ付き） |
| `planAcquisition(gap)` | 実装済み | CapabilityAcquisitionTaskを純粋関数で生成 |
| `verifyAcquiredCapability(cap, acqTask, agentResult)` | 実装済み | LLMで取得済み能力を検証（pass/fail/escalate） |
| `registerCapability(cap, context?)` | 実装済み | registryへの登録（AcquisitionContextサポート済み） |
| `setCapabilityStatus(name, type, status)` | 実装済み | 取得フロー中のステータス更新（"acquiring"等） |
| `escalateToUser(gap, goalId)` | 実装済み | ReportingEngineを通じたユーザー通知 |
| `loadRegistry/saveRegistry` | 実装済み | `~/.motiva/capability_registry.json`へのread/write |
| `getAcquisitionHistory(goalId)` | 実装済み | ゴール単位の取得履歴 |
| `confirmDeficiency(taskId, failCount)` | 実装済み | 連続失敗>=3でdeficiency確定 |

**missing (CapabilityDetector)**: `removeCapability` は実装済み。ただし hotplug/dependency 解決ロジックは一切なし。

### 2.2 TaskLifecycle (`src/task-lifecycle.ts`) — capability配線

- L811: `capabilityDetector.detectDeficiency(task)` を capability_acquisition以外のタスクで呼び出す
- L830: `capabilityDetector.planAcquisition(gap)` を呼び出し `acquisition_task` をTaskCycleResultに添付
- L838: `capabilityDetector.setCapabilityStatus(..., "acquiring")` でステータス更新
- `TaskCycleResult.action` に `"capability_acquiring"` が定義済み
- **Gap**: `capability_acquiring` アクションはCoreLoopで**ハンドルされていない**（後述）

### 2.3 CoreLoop (`src/core-loop.ts`)

- `capability_acquiring` アクションを受け取るハンドラが**存在しない**（Grepで0件）
- 現在の acquisition flow は TaskLifecycle でフラグを立てるだけで止まっており、エージェント委譲まで進まない
- つまり M6.1 の "acquire via agent delegation" 部分は**未実装**

### 2.4 DataSourceRegistry (`src/data-source-adapter.ts`)

| メソッド | 状態 |
|---------|------|
| `register(adapter)` | 実装済み（重複登録はエラー） |
| `getSource(id)` | 実装済み |
| `listSources()` | 実装済み |
| `remove(id)` | 実装済み |
| `has(id)` | 実装済み |

**Gap**: `register()` は重複を拒否するが `replace/update` がない。hot-plug (実行中の入れ替え) には `remove` → `register` の2ステップが必要。dependency管理機能は一切なし。

### 2.5 AdapterRegistry (`src/adapter-layer.ts`)

| メソッド | 状態 |
|---------|------|
| `register(adapter)` | 実装済み（上書き許可） |
| `getAdapter(type)` | 実装済み |
| `listAdapters()` | 実装済み |
| `getAdapterCapabilities()` | 実装済み |

**Note**: AdapterRegistryはDataSourceRegistryと異なり**上書き登録を許可**している（重複排除なし）。つまりAdapterRegistryの方がdynamic re-registrationに既に寛容。

### 2.6 Types (`src/types/capability.ts`)

既存型:
- `CapabilityTypeEnum`: tool / permission / service / data_source
- `CapabilityStatusEnum`: available / missing / requested / acquiring / verification_failed
- `CapabilitySchema`, `CapabilityRegistrySchema`
- `CapabilityGapSchema`, `CapabilityAcquisitionTaskSchema`
- `CapabilityDependencySchema` — `{ capability_id, depends_on: string[] }` は定義されているが**使用箇所ゼロ**
- `CapabilityVerificationResultEnum`: pass / fail / escalate
- `AcquisitionMethodEnum`: tool_creation / permission_request / service_setup

**Gap**: `CapabilityDependencySchema` は型だけあり実装なし。`AcquisitionMethodEnum` に `data_source_setup` がない（`data_source` は `service_setup` にfallback）。

### 2.7 CLI (`src/cli-runner.ts`)

- `motiva datasource add/list/remove` は実装済み
- capabilityに関するCLIサブコマンドは**一切存在しない** (`capability` キーワードのGrep結果: 0件)
- 自動DataSource登録（`autoRegisterFileExistenceDataSources`）は実装済み

### 2.8 テスト (`tests/capability-detector.test.ts`)

カバー済み:
- `detectDeficiency` (gap/no-gap)
- `confirmDeficiency` (failure count threshold)
- `loadRegistry/saveRegistry`
- `registerCapability` (新規/更新、AcquisitionContext付き)
- `setCapabilityStatus` (新規/既存)
- `escalateToUser`
- `planAcquisition` (tool/permission/service/data_source)
- `verifyAcquiredCapability` (pass/fail/escalate)
- `findCapabilityByName`
- `getAcquisitionHistory`
- `removeCapability`
- `detectGoalCapabilityGap`

**Gap**: CoreLoopとの統合テスト（acquisition dispatch cycle）はなし。dependency管理テストはなし。

---

## 3. M6.1: Full Cycle Acquisition — What's Missing

### 現状の断絶

```
TaskLifecycle.runCycle()
  → detectDeficiency(task)
  → planAcquisition(gap)
  → setCapabilityStatus("acquiring")
  → returns { action: "capability_acquiring", acquisition_task }
       ↓
  CoreLoop.runOnce()
    → [capability_acquiring を受け取るが、何もしない] ← ここが空白
```

### M6.1で追加が必要なもの

**1. CoreLoopの`capability_acquiring`ハンドラ** (修正: `src/core-loop.ts`)
- `TaskCycleResult.action === "capability_acquiring"` を受け取って acquisition_task をエージェントに委譲
- 委譲先: 既存のAdapterRegistryからtool_creation/service_setupに適したアダプターを選択
- 委譲後: verifyAcquiredCapability → registerCapability の完了まで元タスクを待機状態に遷移
- 3回失敗でescalateToUser

**2. 待機中タスクの管理**
- 能力取得待ちタスクをどう管理するか。OptionA: タスクに`plateau_until`をセット。OptionB: `status: "waiting_capability"`のような新ステータス追加
- 現在の`TaskStatusEnum`を確認する必要あり

**3. 取得完了後のタスク再開ロジック** (修正: `src/core-loop.ts` or `src/task-lifecycle.ts`)
- 能力登録完了後、待機中だったタスクを自動再開する仕組み

**4. CLIへのcapabilityサブコマンド追加** (修正: `src/cli-runner.ts`) — 任意
- `motiva capability list` / `motiva capability remove <id>` など
- M6.1の本質ではないが、observabilityのために追加推奨

---

## 4. M6.2: Dynamic Capability Registry — What's Missing

### 現状の問題

**DataSourceRegistry**:
- `register()` は重複を`throw`する — hot-plug（同一IDでの入れ替え）ができない
- ObservationEngineはコンストラクタ時に`dataSources`配列を受け取る。実行中の追加/削除通知の仕組みなし
- `CapabilityDependencySchema`は型定義のみ、resolve logic ゼロ

**AdapterRegistry**:
- 上書き登録は可能だが、実行中タスクが古いアダプターインスタンスを参照していた場合の安全性保証なし

### M6.2で追加が必要なもの

**1. DataSourceRegistryの`replace()`または`upsert()`** (修正: `src/data-source-adapter.ts`)
- 既存エントリを安全に入れ替えるメソッド
- 接続解除（`disconnect()`）→登録→接続（`connect()`）のシーケンス保証

**2. ObservationEngineへのdynamic datasource追加** (修正: `src/observation-engine.ts`)
- コンストラクタ引数の配列から`DataSourceRegistry`オブジェクト参照への移行、またはaddDataSource/removeDataSourceメソッド追加
- 現在: `ObservationEngine(stateManager, dataSources: IDataSourceAdapter[], ...)` — 配列なので実行中追加不可

**3. CapabilityDependencyの実装** (修正: `src/capability-detector.ts`)
- `CapabilityDependencySchema`を使った依存解決ロジック
- 能力Aが能力Bに依存する場合、B取得→A取得の順序強制
- 循環依存検出

**4. 新型: CapabilityRegistryManagerクラス** (新規ファイル: `src/capability-registry-manager.ts`) — 任意
- hot-plug管理の責務を分離するなら新クラスが適切
- CapabilityDetectorに混ぜるか分離するかは設計判断

---

## 5. ファイル別: 新規作成 vs 修正

| ファイル | アクション | 理由 |
|---------|----------|------|
| `src/core-loop.ts` | **修正** | `capability_acquiring`ハンドラ追加（M6.1の核心） |
| `src/task-lifecycle.ts` | **修正** | 待機状態への遷移ロジック（M6.1補完） |
| `src/data-source-adapter.ts` | **修正** | `replace()`/`upsert()`追加、hot-plug対応（M6.2） |
| `src/observation-engine.ts` | **修正** | dynamic datasource追加対応（M6.2） |
| `src/capability-detector.ts` | **修正** | dependency resolve追加（M6.2）。M6.1は現状維持でOK |
| `src/types/capability.ts` | **修正軽微** | `AcquisitionMethodEnum`に`data_source_setup`追加可能（任意） |
| `src/cli-runner.ts` | **修正軽微** | `motiva capability list/remove` 追加（任意） |
| `src/capability-registry-manager.ts` | **新規（任意）** | hot-plug管理の責務分離が必要なら |
| `tests/core-loop-capability.test.ts` | **新規** | CoreLoopのfull-cycleテスト（M6.1） |
| `tests/data-source-hotplug.test.ts` | **新規** | hot-plug/dependency管理テスト（M6.2） |

---

## 6. 複雑度見積もり

### M6.1: Full Cycle Acquisition

| サブタスク | 複雑度 | 根拠 |
|-----------|--------|------|
| CoreLoop `capability_acquiring` ハンドラ | **高** | 非同期フロー制御（委譲→検証→登録→再開）、待機中タスク管理、エラー分岐が多い |
| 待機タスク管理（plateau_until or 新ステータス） | **中** | TaskStatusEnumへの影響次第。既存`plateau_until`流用なら低 |
| 取得後の再開ロジック | **中** | CoreLoopの次ループで自然に拾うか、明示的再スケジュールか |
| CLIサブコマンド追加 | **低** | 既存datasourceコマンドのコピー |

**M6.1合計: 3-4ファイル変更、中〜高難度**

### M6.2: Dynamic Capability Registry

| サブタスク | 複雑度 | 根拠 |
|-----------|--------|------|
| DataSourceRegistry `replace/upsert` | **低** | 既存`remove+register`の組み合わせ |
| ObservationEngine dynamic追加対応 | **中** | コンストラクタシグネチャ変更はCLIRunner等の呼び出し側を全部直す必要あり |
| CapabilityDependency実装 | **中** | DAGのトポロジカルソートと循環検出。ロジック自体はシンプルだがテストが必要 |
| CapabilityRegistryManager (分離) | **低〜中** | 新クラスだが責務は明確 |

**M6.2合計: 3-5ファイル変更、中難度**

---

## 7. Key Gaps Summary (What's Completely Missing)

1. **CoreLoopの`capability_acquiring`ハンドラ** — M6.1の中核。TaskLifecycleはフラグを返すが、CoreLoopは何もしない。
2. **能力取得タスクのエージェント委譲実装** — `planAcquisition()`でAcquisitionTaskは作られるが、実際にエージェントに渡して実行するコードがない。
3. **DataSourceRegistry hot-plug対応** — `register()`が重複拒否のため、実行中のアダプター入れ替えが不可能。
4. **ObservationEngineへの動的datasource追加** — コンストラクタ時固定配列なので、実行後に追加した能力は次回CLI起動まで反映されない。
5. **CapabilityDependency解決ロジック** — 型定義(`CapabilityDependencySchema`)はあるが実装ゼロ。
6. **capability CLIサブコマンド** — `motiva capability list/show` がない（datasourceはある）。

---

## 8. Confidence Labels

- CoreLoopの`capability_acquiring`未実装: **Confirmed** (Grep 0件)
- DataSourceRegistryの重複拒否問題: **Confirmed** (L243-247コード確認)
- ObservationEngine固定配列問題: **Confirmed** (cli-runner.ts L158で配列渡し確認)
- CapabilityDependency実装ゼロ: **Confirmed** (Grep 0件)
- planAcquisition/verifyAcquiredCapability完全実装済み: **Confirmed** (コード確認)
- テストのcoreloop統合カバレッジなし: **Confirmed** (テストファイルはcapability-detector.test.tsのみ)
