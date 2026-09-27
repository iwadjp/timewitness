# Timewitness

[English](#english) | [日本語](#日本語)

## English

Timewitness checks that a newly added regression test **fails before the fix
and passes after it**, by actually running the test against the pre-fix code —
straight from a dirty working tree, without commits, stashes or a clean base.

### Why

When an AI coding assistant writes a fix and its regression test together,
"the test passes on the current tree" is not evidence that the test would have
failed without the fix. Checking that by hand means reverting commits, setting
up another working copy, or asking follow-up questions about which change was
needed — and in a dirty working tree, Git's `HEAD` is not necessarily the
"before" state either.

Timewitness snapshots your working files before you edit (`arm`), then runs the
current test against that snapshot and against the current tree (`prove`).

### Try it

Requires Windows, Git and Node.js 24 or later. No clone is needed:

```powershell
cd <your-repo>
npx github:iwadjp/timewitness arm

# fix the bug and add a regression test as usual

npx github:iwadjp/timewitness prove --test test/foo.test.js
```

```text
TIMEWITNESS: PROVEN

Before: FAIL 2/2
After : PASS 2/2

Witnessed changes (whole set):
- lib/foo.cjs
Test: test/foo.test.js
Environment: EXISTING_ENV / same manifests / same command / same cwd
Reason: REPEATED_ASSERTION_FAIL_TO_PASS
Evidence: runs/<run-id>/report.json
```

To run from a clone instead:

```powershell
git clone https://github.com/iwadjp/timewitness.git
node timewitness\timewitness.cjs arm --repo <your-repo>
```

`--repo` defaults to the current directory. `node timewitness.cjs --help`
(or `npx github:iwadjp/timewitness --help`) prints all options.

### Verdicts

| Verdict | Meaning | Exit code |
|---|---|---|
| PROVEN | Same test, command, cwd, environment and dependency copy; the same assertion failure turns into a pass, consistently across every repetition | 0 |
| NOT_PROVEN | The test also passes before, still fails after, the test set/command/cwd differs, or there is no comparable difference or evidence | 2 |
| INCONCLUSIVE | skip/todo, timeout, discovery/setup failure, dependency or environment difference, flaky results, not reproducible, or files changed during capture | 3 |
| Usage error | Bad arguments, no baseline, repository/storage not usable | 1 |

**PROVEN does not mean** the whole fix is correct, that test coverage is
sufficient, or that the bug is fully fixed. It is limited evidence that *this
selected test*, when executed, tells the saved "before" world apart from the
current one.

### How the dirty tree is handled

- No committed base ref is needed. Timewitness never commits or stashes.
- The "before" state is **the working files at `arm` time** — not the index and
  not `HEAD`.
- Your Git working tree is only read: no reset, checkout, restore, stage or
  commit.
- `--repeat` (default 2, range 1–10) runs each side several times; mixed results
  are INCONCLUSIVE.
- Environment, command, cwd and the `node_modules` bytes are compared between
  `arm` and `prove`; any difference prevents PROVEN.

### Checked against a real bug fix

Run against a real commit from another of the author's projects
(`d290a13 "Fix latest Layer 1 run selection"`, reduced to the affected source
and tests — see [`evidence/real-bug-d290a13/NOTES.md`](evidence/real-bug-d290a13/NOTES.md)),
Timewitness returned `PROVEN` (Before: FAIL 3/3, After: PASS 3/3). A synthetic
negative control unrelated to the fix (`assert.equal(1 + 1, 2)`) in the same
environment returned `NOT_PROVEN` with `BEFORE_ALSO_PASSES`. Neither run produced
a false PROVEN. The raw reports are in the same directory.

### Supported scope (v0.1)

- Windows, Git, Node.js 24+; `node:test` only.
- Staged, unstaged and untracked changes are all captured as the actual bytes
  on disk at `arm` time. Ignored files inside the scope are not captured; `prove`
  reports them as a reason for INCONCLUSIVE.
- `--scope` (repeatable) limits capture to repo-relative directories, e.g.
  separate source and test directories. Dependency reproduction is always
  checked at the Git root.
- `--test` (repeatable) names the tests to run; otherwise new or changed
  `*.test.*` / `*.spec.*` files are selected.
- `--repeat` 1–10 (default 2), `--timeout-ms` 50–600000 (default 15000).

### Limitations

- A single root `package.json` only; npm/pnpm/yarn workspaces are not supported.
- Dependencies are reproduced by checking that the existing `node_modules` is
  byte-identical; nothing is installed from a lockfile.
- pnpm/yarn lockfiles, nested packages, dependency symlinks/junctions and native
  `.node` modules are reported as `ENVIRONMENT_NOT_REPRODUCED`.
- Large dependency trees (over 128 MiB / 12,000 files) and large sources (over
  64 MiB / 2,000 files) are not partially proven.
- Browser projects, build steps and general npm scripts are out of scope, as are
  hidden dependencies on files outside the scope.

### Safety and privacy

- Your working tree is never modified; before/after run in separate copies.
- Source copies are kept, **unencrypted**, under
  `%LOCALAPPDATA%\Timewitness\v01\<repo-scope-key>` and are not cleaned up
  automatically. Do not share that directory if your source is sensitive.
- Timewitness itself makes no network connections. Test names are matched by
  HMAC, and raw stdout/stderr are never saved.
- The copies are **not an OS security sandbox**: a test that writes to external
  paths, services or the network can still do so. Only run trusted tests.

### Tests

```powershell
npm test
```

49 tests cover path edge cases, staged/mixed/index handling, binary files, line
endings, file modes, nested repositories and worktrees, hook/setup failures,
dependency differences, flakiness, privacy, and more. Validation evidence is in
`evidence/v01-validation/` and `evidence/real-bug-d290a13/`. The detailed notes
below (in Japanese) cover FULL_WITNESS, capture details, dependency handling,
the exact command that is executed, and false-PROVEN safeguards.

**Article (English):** [When AI writes the fix and the test together, is PASS enough?](https://dev.to/iwadjp/when-ai-writes-the-fix-and-the-test-together-is-pass-enough-1n2p)

License: [PolyForm Noncommercial 1.0.0](LICENSE).

---

## 日本語

新しく追加した回帰テストが、fix前ではFAILしfix後ではPASSすることを、**dirty working treeのまま**実行して確かめます。

## Why

AI coding assistantがfixとregression testを同時に書くと、「今のtreeでtestがPASSする」ことは、
「fix前ならそのtestはFAILしていた」ことの証拠にはなりません。人間はcommitを戻したり、
別の作業場所を作ったり、追加の会話でどの変更が必要だったかを確認することになります。
すでにdirtyな作業状態では、GitのHEADが「修正前」とも限りません。

Timewitnessは、現在のtestを実際に「修正前」の状態へ持ち込み、実行して確かめます。

## 30秒で分かる例

```powershell
node timewitness.cjs arm

# 普段どおりコードを修正し、regression testを追加する

node timewitness.cjs prove --test test/foo.test.js
```

```text
TIMEWITNESS: PROVEN

Before: FAIL 2/2
After : PASS 2/2

Witnessed changes (whole set):
- lib/foo.cjs
Test: test/foo.test.js
Environment: EXISTING_ENV / same manifests / same command / same cwd
Reason: REPEATED_ASSERTION_FAIL_TO_PASS
Evidence: runs/<run-id>/report.json
```

## 判定の意味

| 判定 | 意味 | CLI終了値 |
|---|---|---|
| PROVEN | 同一test・command・cwd・環境・依存コピーで、同じassertion失敗から成功へ。全反復一致 | 0 |
| NOT_PROVEN | beforeもPASS、afterもFAIL、test集合/command/cwdが違う、比較差分や証拠がない | 2 |
| INCONCLUSIVE | skip/todo、timeout、discovery/setup失敗、依存・環境差、揺れ、再現不能、取得中の変更 | 3 |
| 操作エラー | 引数不正、baselineなし、repo/storage操作不能 | 1 |

**PROVENが意味しないこと:**

- fix全体が正しいことの証明ではありません
- test coverageが十分であることの証明ではありません
- bugが完全に直ったことの証明ではありません

PROVENは、保存したworldと現在worldを、**この選んだtestが実行によって識別した**という限定的な証拠です。
仕様の正しさ、唯一の原因、全入力での正しさ、将来の非flaky性までは証明しません。

## dirty treeを扱う仕組み

- committed base refは不要です。commitもstashもしません。
- 対象は **arm時点のworking files** です。stagedへの巻き戻しやHEADの読み替えではありません。
- 元のGit working treeへreset / checkout / restore / stage / commitは一切行いません。読取りのみに使います。
- `--repeat`（既定2、1〜10）で複数回実行し、一致しなければINCONCLUSIVEにします。
- 環境・command・cwd・依存node_modulesのbyte一致もarmとproveで比較し、差があればPROVENにしません。

## 実在bugでの検証（commit d290a13）

このprototypeとは別の、作者の私用プロジェクトの実commit
`d290a13 "Fix latest Layer 1 run selection"` を使って検証しました
（該当sourceとtestだけを取り出した、private-dataを含まない再現環境。詳細は
[`evidence/real-bug-d290a13/NOTES.md`](evidence/real-bug-d290a13/NOTES.md)）。

```text
node timewitness.cjs prove --scope automation --scope test \
  --test test/layer1-dashboard-runs.test.js \
  --test test/layer1-dashboard-read-api.test.js \
  --test test/layer1-snapshot.test.js --repeat 3

TIMEWITNESS: PROVEN
Before: FAIL 3/3
After : PASS 3/3
```

同じ環境で、fixと無関係な合成negative control（`assert.equal(1 + 1, 2)`）も実行しました。

```text
node timewitness.cjs prove --scope automation --scope test \
  --test test/unrelated.test.cjs --repeat 2

TIMEWITNESS: NOT_PROVEN
Before: PASS 2/2
After : PASS 2/2
Reason: BEFORE_ALSO_PASSES
```

この2回の実行でfalse PROVEN(誤ってPROVENと判定したケース)は **0件** でした。
生のreport.jsonは同ディレクトリの `PROVEN.json` / `NOT_PROVEN-negative-control.json` にあります。

## Supported scope（v0.1）

- Windows / Git / Node.js 24以上
- `node:test`のみ（他のtest runnerは対象外）
- staged/unstaged/untrackedのいずれも、arm時点の**working treeの実byte**として区別なく取得します
  （git indexの状態ではなくdisk上の内容を見ます）。無視されたfile（`.gitignore`対象）はscope内にあっても
  取得せず、`prove`実行時にINCONCLUSIVEの理由として明示します。
- `--scope`（repeatable）でGit rootからの相対directoryを複数指定可能。sourceとtestが別directoryでも、
  index等の手作業なしに対象を絞れます。依存（package.json/lockfile/node_modules）の再現判定は常にGit root基準です。
- `--test`（repeatable）で対象testを明示可能。省略時は新規・変更された`*.test.cjs/js/mjs`等を自動選択します。
- `--repeat`は1〜10（既定2）、`--timeout-ms`は50〜600000（既定15000）。

## Limitations

- npm workspaces / pnpm / yarn workspacesの一般対応はありません。ルート直下の単一`package.json`のみ対象です。
- 依存の再現は既存`node_modules`のbyte一致確認であり、lockfileからのinstallは行いません。npm install/ciは自動実行しません。
- pnpm-lock.yaml / yarn.lock、nested package、dependency symlink/junction、native `.node`は未対応（`ENVIRONMENT_NOT_REPRODUCED`）。
- node_modulesが複雑・巨大（128 MiB / 12000 file超）なrepoではdependency再現を諦め、`ENVIRONMENT_NOT_REPRODUCED`扱いにしてPROVENを出しません。
- `Node.js`/`node:test`限定です。ブラウザ・ビルドを伴うプロジェクト・一般npm scriptsは対象外。
- コードの隠れた依存関係（scope外のfileを読むコード等）は証明しません。scope外への依存が必要なtestは対象外です。
- 任意のecosystem・言語には対応しません。
- source captureは最大64 MiB / 2000 file、依存copyは最大128 MiB / 12000 fileが上限です。超過時は部分的な証明にしません。
- sandboxのcopyはローカルに保持されます。削除・自動cleanupは行いません（詳細は次項）。

## Safety / Privacy

- 元のGit working treeへreset / checkout / restore / stage / commitは一切行いません。読取り専用です。
- before/afterはそれぞれ独立したisolated worldとして、arm時点のcopyから実行します。元のfileには触れません。
- sourceのcopyは **`%LOCALAPPDATA%\Timewitness\v01\<repo-scope-key>` にローカル保存されます。暗号化はしません。**
- クラウドへの送信は一切ありません（Timewitness自身にnetwork通信はありません）。
- test名はHMACで照合し、report本体には保存しません。stdout/stderrはbyte数のみ記録し、raw logは自動保存しません。
- **ただし**: sandbox copyにはsource本文がそのまま残ります。fileが機密情報を含む場合、そのままlocalに残る点に注意してください。
  保存rootを他人と共有しないでください。
- テストコードそのものが外部path・service・networkへ書き込む場合、Timewitnessはそれを遮断しません
  （OSレベルのsandboxではありません）。信頼できるtestだけを対象にしてください。

## Install / Run

インストール手順はありません。cloneした場所からNode 24以上で直接実行します。

```powershell
git clone https://github.com/iwadjp/timewitness.git
cd timewitness
node timewitness.cjs arm --repo <対象repoのpath>
```

`--repo`を省略すると現在のdirectoryが対象repoになります。global installやnpm publishは行いません。

cloneせずに試す場合は、対象repoで `npx github:iwadjp/timewitness arm` / `npx github:iwadjp/timewitness prove --test <test>` のように実行できます（Node 24以上）。

## 詳細ドキュメント

以下は補足の詳細です。通常の利用には上記だけで十分です。

### FULL_WITNESSの意味

現在の**選択したtestファイルだけ**をbeforeへ移植します。それ以外の取得対象ファイルはarm時点へ戻したコピーです。
test/helperやfixtureも自動移植しません。helperに本体コードが含まれていても、変更を証拠から隠さないためです。
追加helperがbeforeに存在しない場合はINCONCLUSIVEになり得ます。v0.1では自己完結した回帰testが適しています。

`Witnessed changes` は比較した変更集合全体です。複数fileがあれば、その集合の識別が成立したという意味です。
各fileが必要だったという主張はしません。旧prototypeの単発file ablation、`--max-files`、FOCUSED_WITNESSは提供しません。

### 保存の詳細

- Gitはroot・HEAD・status・tracked/untracked一覧・index所在の**読取りだけ**に利用します。
- working filesの生byteとOSのmodeを保存。binary、CRLF/LF、空白path、add/delete/renameを別worldへ再現します。
- 通常のlinked worktreeを対象にできます。親repoからnested repo/worktreeへは入りません。
- 取得の前後と実行後にsource・依存・HEAD・index/status・実行binaryを確認。変化時はINCONCLUSIVEです。
- copyを毎回作り、**全実行で同じ絶対cwd**を再利用します。完了worldは個別名へ移動して保持します。
- 相対file modeは保存しますが、WindowsではPOSIX executable-bitの完全再現を主張しません。

### Node.jsと依存関係

`package.json`、npmのlockfile、node_modulesの内容hashをarmとproveで比較します。
manifestやlockfileが変わった場合、依存の実fileが変わった場合、宣言された依存が未導入の場合は **ENVIRONMENT_NOT_REPRODUCED / INCONCLUSIVE** です。

| 表示 | 内容 |
|---|---|
| EXISTING_ENV / NODE_BUILTINS_ONLY | 宣言された外部依存なし、Node標準moduleを使用 |
| EXISTING_ENV / COPIED_NODE_MODULES | armと一致する既存node_modulesを、各worldへ独立コピー |
| ENVIRONMENT_NOT_REPRODUCED | 差・欠落・上限・未対応構成があり、証明を実行しない |
| LOCKFILE_REPRODUCED | **未実装。v0.1はこの表示を出さない** |

コピー対象は最大128 MiB / 12000 dependency files。書込み可能なnode_modulesを共有しません。
既存環境のbyte一致を確認する方式であり、lockfileからinstallしたことやlockfileと導入済みversionの整合性を保証するものではありません。

ignored file、private-data、evidence/build/dist/coverage、`.env`、`.npmrc`、鍵file、link等の未取得入力がscope内にあれば、黙って再現成功にせずINCONCLUSIVEにします。

### 何を実行するか

`prove --help` ではなく `node timewitness.cjs --help` で形式を確認できます。
実際には、このCLIを起動したNode binaryへ、次の**配列引数**を直接渡します。

```text
<this Node binary>
  --test
  --test-isolation=none
  --test-concurrency=1
  --test-timeout=<ms>
  --test-reporter=<Timewitness reporterのfile URL>
  ./<選択test1>
  ./<選択test2>
```

shellを経由しません。quoted pathはPowerShell/cmdが引数化し、その後はliteral pathとして扱います。
任意command文字列、shell operator、npm testのscript、loader、ユーザー指定reporterは実行しません。

環境変数はPATH、Windowsの起動用変数、LANG/LC_ALL/TZだけ継承し、HOME/TEMP等は同じsandbox内へ固定します。
親のNODE_TEST_CONTEXT、NODE_OPTIONS、Git routing、npm設定、credential等は継承しません。

**コピーはOSのsecurity sandboxではありません。**
信頼でき、外部path・サービス・networkへの副作用や常駐child processを持たないtestだけを実行してください。

### False PROVEN対策

- skip/todoが1件でもあればINCONCLUSIVE。空fileの暗黙の成功も実行testとして数えません。
- timeoutをassertion FAILへ変換しません。setup/hook失敗、import失敗、異常exit、report欠落もINCONCLUSIVEです。
- Nodeの `ERR_ASSERTION` かつtest本体失敗だけをwitness候補にします。
- 同一のtest ID集合と失敗→成功の対応が必要。同名の曖昧なtestは拒否します。
- 反復で結果が混ざるとINCONCLUSIVE。テスト中の取得済みsource・dependency変更も拒否します。

## 検証

```powershell
npm test
```

49 tests: パス境界/拡張子なし、比較状態、staged/mixed/index不変、binary/改行/mode/空白/large file、
nested repo/worktree境界、hook/setup失敗、dependency差、flakiness、privacy、
親test環境継承、Windows reporter file URL、相対pathの回帰などを検証します。

第一対象はWindows / Git / Node.js 24 / node:test。別ecosystemや一般のnpm scripts、ブラウザ、
外部service、OS隔離、完全な原子的snapshot、保存容量の自動管理は対象外です。
詳細な証拠は `evidence/v01-validation/` と `evidence/real-bug-d290a13/` を参照してください。

## Related tools

This project is part of a small set of tools for investigating AI-coding and
debugging problems that Git alone cannot explain.

- [Timewitness](https://github.com/iwadjp/timewitness) — check whether a regression test fails before a fix and passes after it.
- [wipwho](https://github.com/iwadjp/wipwho) — split mixed uncommitted Claude/Codex changes into request-level patches.
- [Ember](https://github.com/iwadjp/ember) — recover source retained by a still-running Node.js process.
- [Worldbisect](https://github.com/iwadjp/worldbisect) — reduce same-commit environment differences to an observed 1-minimal reproducing set.
- [Afterimage](https://github.com/iwadjp/afterimage) — inspect retained NTFS USN history after an agent run.

[Overview and articles](https://blog2020.iwadjp.com/2026/09/18/ai-coding-debugging-tools-portfolio/)

**Article:** [AIが書いたregression test、本当にbugを検出している？ Timewitnessでfix前後を確かめる](https://blog2020.iwadjp.com/2026/09/16/timewitness-regression-test-proof-dirty-tree/)
