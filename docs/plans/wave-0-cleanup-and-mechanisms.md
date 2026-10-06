# 波 0：清噪与机制补强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清零 knip 死代码发现与 rustc dead_code 警告，显式化 `hast` 类型依赖，引入循环依赖门禁，并把两个新门禁接入 `ci:local`。

**Architecture:** 纯删除与工具链变更，零运行时行为变化。三份测量（尺寸/重复/死代码）在波末信号干净，为波 1 起的拆分提供可信基线。

**Tech Stack:** knip 6.39.0、madge 8.0.0、@types/hast 3.0.5、cargo clippy（rustc dead_code）。

**Spec:** `docs/plans/code-quality-refactor-plan.md`（v2）「波 0」一节。

## Global Constraints

- 行为保持红线：本波只删除无引用代码/类型、添加开发依赖与门禁脚本；不改任何运行时逻辑。
- 兼容标识（`mmd-*` 事件、`mmd.*` 键、`MMD_*` 环境变量、`local.mmd.editor` 等）零改动。
- 新依赖固定精确版本：`@types/hast@3.0.5`、`madge@8.0.0`。
- 单次提交约 400 行，超 800 行 pre-commit 拒绝；本波不应触碰 code-size 基线（删除只减不增，若 `check-code-size` 报告 removed 属正常）。
- 每个任务完成即提交，提交信息为简短祈使句；不推送远端。
- 实测修正：Rust dead_code 为 **24 处 / 6 文件**（spec 中「约 180」有误，波末回写）。

## Review Focus

1. **符号被字符串/动态引用**（事件名、命令名常量）——删除前必须全仓检索符号名，仅定义处命中才删；任何存疑项改为「去掉 `export` 保留本地使用」并在提交说明。
2. **`types.ts` 协议接口可能是 IPC 契约载体**——删除前同时检索 `docs/` 归属文档；文档引用的保留并去 `export`。
3. **dead_code 可见性口径差异**（`--lib --tests` 与纯 `cargo check` 不同）——Rust 任务用双口径验证归零。
4. **knip 配置清理误伤**——`ignoreDependencies` 条目移除后若脚本名变化会复发 unused devDeps；清理与 `package.json` 脚本核对同步骤。
5. **madge 漏检**（tsconfig 别名、未处理文件）——验证处理文件数不少于 `src` 下 ts/tsx 文件总数。

---

### Task 1: TS 死代码——Markdown 预处理域

**Files:**
- Modify: `src/lib/markdownPreprocess.ts`、`src/lib/markdown/fences.ts`、`src/lib/markdown/gfmTables.ts`、`src/lib/markdown/math.ts`、`src/lib/markdownMemeImage.ts`、`src/lib/headingPunct.tsx`

**Interfaces:**
- Consumes: knip 当前发现清单（`npx knip --no-progress`）。
- Produces: 上述文件中下列符号不再导出或被删除：`COMMON_MARKDOWN_FENCE_SPLIT_RE`（fences 与 markdownPreprocess 两处）、`applyOutsideCommonFenceBlocks`、`preserveHardLineBreaksInBlockquotes`、`normalizeDoubleBackslashesInMathDelimiters`、`escapeGfmTableCellPipes`、`escapePipesInInlineCode`（两处）、`splitGfmTableRow`、`escapeCurrencyDollarSigns`（两处）、`MEME_IMAGE_FALLBACK_ALT`、`JINXIU_HEADING_SYMBOL_SPLIT`。

> 执行校正：`splitGfmTableRow` 在 `markdownPreprocess.ts` 的再导出已
> 删除，但 `markdown/gfmTables.ts` 的本体导出保留——`gfmTables.test.ts`
> 直接导入该符号，knip 不视为未使用。清单转录时未区分这两处。

- [x] **Step 1: 逐符号全仓检索确认无引用**

Run: `grep -rn '<符号名>' src scripts docs --include='*' | grep -v '<定义文件>'`
Expected: 每个符号除定义与 knip 输出外零命中；有命中者保留（去 `export`）并记录在提交说明。

- [x] **Step 2: 删除符号或去除 `export`**

`markdownPreprocess.ts` 中的同名行是再导出，直接删除该行；底层 `markdown/` 中仍被文件内部使用的只去掉 `export`，完全无用的整体删除。

- [x] **Step 3: 验证**

Run: `npm run typecheck && npm run lint && npx vitest run src/lib/markdown`
Expected: 全部通过，无新错误。

- [x] **Step 4: Commit**

```bash
git add -u && git commit -m "refactor(markdown): 清理预处理域未使用导出"
```

### Task 2: TS 死代码——协议与状态域

**Files:**
- Modify: `src/lib/activeDocumentWatch.ts`、`src/lib/locale.ts`、`src/lib/localeRuntime.ts`、`src/lib/paneSync.ts`、`src/lib/pdfAssetManifest.ts`、`src/lib/settings.ts`、`src/lib/theme.ts`、`src/lib/workspaceFileKind.ts`、`src/lib/openIntent.ts`、`src/lib/fileTree.ts`、`src/lib/fileTreeClipboard.ts`、`src/lib/fileTreeContextMenu.ts`、`src/lib/crashDrafts.ts`、`src/lib/docxResources.ts`、`src/lib/exportPreflight.ts`、`src/lib/tauriCommands.ts`、`src/hooks/useSettings.ts`

**Interfaces:**
- Produces: 删除或去 `export`：`SETTINGS_UPDATED_EVENT`、`ACTIVE_DOCUMENT_WATCH_EVENT`、`ACTIVE_DOCUMENT_WATCH_PROTOCOL_VERSION`、`ActiveDocumentDiskSnapshot`、`ActiveDocumentWatchReason`、`LOCALE_MODES`、`LOCALE_PREFERENCE_VERSION`、`LocaleUnlisten`、`PANE_PROTOCOL_VERSION`、`PANE_BINARY_SOURCE_LIMITS`、`PaneStatePayload`、`PaneContentChangePayload`、`PaneDocumentIdentity`、`PDFJS_VERSION`、`PdfAssetManifestFile`、`AUTOSAVE_MODES`、`THEME_PREFERENCE_VERSION`、`SkinAppearance`、`BINARY_DOCUMENT_SOURCE_LIMITS`、`OpenIntentSource`、`WorkspaceSearchOpenSelection`、`WorkspaceFileTreeFolder`、`WorkspaceFileTreeFile`、`FileTreeClipboardMode`、`FileTreeContextTargetKind`、`CrashDraftFileKind`、`CrashDraftLimits`、`CorruptCrashDraftEntry`、`UnsupportedCrashDraftEntry`、`CrashDraftErrorCode`、`DocxImageMimeType`、`ExportPreflightIssueKind`、`listRecentFiles`、`removeRecentFile`。

- [x] **Step 1: 逐符号检索（含 docs/）确认无引用**

Run: `grep -rn '<符号名>' src scripts docs | grep -v '<定义文件>'`
Expected: 零命中才可整体删除；`docs/` 有引用者保留并去 `export`。

- [x] **Step 2: 删除或去 `export`（同 Task 1 规则）**

- [x] **Step 3: 验证**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 全部通过。

- [x] **Step 4: Commit**

```bash
git add -u && git commit -m "refactor(lib): 清理协议与状态域未使用导出"
```

### Task 3: TS 死代码——组件与类型，knip Unused 归零

**Files:**
- Modify: `src/components/markdown/MemeImage.tsx`、`src/components/markdown/MermaidDiagram.tsx`、`src/components/ExportDialog.tsx`、`src/components/WorkspaceEntryDialog.tsx`、`src/types.ts`、`src/styles/themeTokens.ts`、`src/lib/themeRuntime.ts`、`src/lib/appFeedback.ts`

**Interfaces:**
- Produces: 删除或去 `export`：`MemeImage` 默认导出改命名、`MemeImageProps`、`MERMAID_CONFIG`、`sanitizeMermaidSvg`、`ExportFormat`、`WorkspaceEntryKind`、`CanonicalThemeToken`、`ThemeRuntimeSnapshot`、`FeedbackDialogKind`、`FeedbackDialogRole`、`ContentMode`、`OpenMarkdownFileResponse`、`OpenImageFileResponse`、`OpenHtmlFileResponse`、`OpenExcalidrawFileResponse`、`OpenMediaFileResponse`、`OpenBinaryDocumentResponse`、`WorkspaceIndexLimits`、`MutationCommitReceipt`、`MutationKind`。

- [x] **Step 1: 逐符号检索（`types.ts` 的 IPC 接口必须含 `docs/` 检索）**

Run: `grep -rn '<符号名>' src scripts docs | grep -v '<定义文件>'`

- [x] **Step 2: 删除或去 `export`；`MemeImage` 若确有消费方按其引用方式调整**

- [x] **Step 3: 验证 knip Unused 清零**

Run: `npx knip --no-progress | grep -cE '^Unused (exports|exported types)'`
Expected: `0`

- [x] **Step 4: 验证套件并提交**

Run: `npm run typecheck && npm test`
```bash
git add -u && git commit -m "refactor(components): 清理未使用导出与类型"
```

### Task 4: `hast` 显式类型依赖

**Files:**
- Modify: `package.json`、`package-lock.json`

- [x] **Step 1: 安装固定版本**

Run: `npm install --save-dev --save-exact @types/hast@3.0.5`

- [x] **Step 2: 验证幻影依赖消除且类型可解析**

Run: `npx knip --no-progress | grep -c 'hast'` → `0`；`npm run typecheck` 通过。

- [x] **Step 3: Commit**

```bash
git add package.json package-lock.json && git commit -m "chore(deps): 显式声明 hast 类型依赖"
```

### Task 5: Rust dead_code 清偿（path_auth 与 open_intent）

**Files:**
- Modify: `src-tauri/src/path_auth.rs`、`src-tauri/src/open_intent.rs`

**Interfaces:**
- Produces: 双口径零 dead_code：`--lib --tests` 与纯 `cargo check` 下这两个文件不再出现 `never used/read/constructed` 警告（当前 10 + 5 处）。

- [x] **Step 1: 列出当前警告**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --message-format short 2>&1 | grep -E 'path_auth|open_intent' | grep -E 'never (used|read|constructed)'`
Expected: 15 行（记录清单）。

- [x] **Step 2: 逐项处置**

真死（全仓 `grep -rn '<名称>' src-tauri/src` 零引用）→ 删除；仅测试构建可见 → 移入 `#[cfg(test)]` 或在该项上加 `#[allow(dead_code)]` 并注释理由（中文一行）。

- [x] **Step 3: 双口径验证**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep 'path_auth\|open_intent' | grep -cE 'never (used|read|constructed)'`
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --message-format short 2>&1 | grep 'path_auth\|open_intent' | grep -cE 'never (used|read|constructed)'`
Expected: 均为 `0`。

- [x] **Step 4: 测试并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
```bash
git add -u && git commit -m "tauri: 清理 path_auth 与 open_intent 死代码"
```

### Task 6: Rust dead_code 清偿（其余四文件）并归零

**Files:**
- Modify: `src-tauri/src/commands.rs`（4）、`src-tauri/src/models.rs`（2）、`src-tauri/src/crash_drafts.rs`（2）、`src-tauri/src/markdown_files.rs`（1）

- [x] **Step 1: 同 Task 5 规则处置 9 处**

- [x] **Step 2: 全仓 dead_code 双口径归零验证**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --message-format short 2>&1 | grep -cE 'never (used|read|constructed)'` 与 `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep -cE 'never (used|read|constructed)'`
Expected: 均为 `0`。

- [x] **Step 3: 测试并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
```bash
git add -u && git commit -m "tauri: 清理剩余死代码并双口径归零"
```

### Task 7: 循环依赖门禁

**Files:**
- Create: 无新脚本（直接用 madge）
- Modify: `package.json`、`knip.config.ts`（清理 4 条 Configuration hints）

**Interfaces:**
- Produces: npm 脚本 `check:circular` = `madge --circular --extensions ts,tsx src`；`knip.config.ts` 移除 `ignoreDependencies` 中 `jscpd`、`lint-staged`（如 knip 复报 unused devDeps 则保留该条并说明）与 `vite.config.ts` 冗余 entry/project 条目。

- [x] **Step 1: 安装并加脚本**

Run: `npm install --save-dev --save-exact madge@8.0.0`，在 `package.json` scripts 增加 `"check:circular": "madge --circular --extensions ts,tsx src"`。

- [x] **Step 2: 验证门禁绿且覆盖完整**

Run: `npm run check:circular`
Expected: `No circular dependency found!`（当前实测为零环，直接门禁化，无需基线）。
Run: `npm run check:circular 2>&1 | grep -oE 'Processed [0-9]+ files'` 对比 `find src -name '*.ts' -o -name '*.tsx' | wc -l`
Expected: madge 处理数 ≥ ts/tsx 文件总数（未漏检）。

- [x] **Step 3: knip 配置清理并验证零 hints**

Run: `npx knip --no-progress`
Expected: 除 Unlisted/Unused 外无 `Configuration hints` 段；`npm run check:dead-code` 若因 ignoreDependencies 移除报 unused devDeps，则恢复对应条目并在提交说明记录原因。

- [x] **Step 4: Commit**

```bash
git add package.json package-lock.json knip.config.ts && git commit -m "feat(quality): 新增循环依赖门禁并收敛 knip 配置"
```

### Task 8: 门禁接入 ci:local 与文档同步

**Files:**
- Modify: `scripts/ci/local-ci.mjs`、`scripts/ci/local-ci.node-test.mjs`、`docs/testing/validation-matrix.md`、`AGENTS.md`

**Interfaces:**
- Produces: `buildDefaultSteps()` 在 `duplication ratchet` 后新增 `dead-code`（`npm run check:dead-code`）与 `circular deps`（`npm run check:circular`）两步，共 13 步；`local-ci.node-test.mjs` 的名称断言同步。

- [x] **Step 1: 更新 local-ci 步骤与断言（测试先行：先改 node-test 预期再改实现）**

Run: `node --test scripts/ci/local-ci.node-test.mjs`
Expected: 先失败（步骤名不匹配），改 `local-ci.mjs` 后通过。

- [x] **Step 2: 文档同步**

`validation-matrix.md`：门禁清单中 `check:dead-code` 与 `check:circular` 改为「已接入 ci:local」，手动序列追加两命令，快照数字更新；`AGENTS.md`「代码质量与防腐约定」补 `check:circular` 一行。

- [x] **Step 3: 验证并提交**

Run: `node -e "import('./scripts/ci/local-ci.mjs').then(m => console.log(m.buildDefaultSteps().length))"`
Expected: `13`。
```bash
git add -u && git commit -m "ci: 死代码与循环依赖门禁接入本地验证"
```

### Task 9: 波 0 验收与 spec 回写

**Files:**
- Modify: `docs/plans/code-quality-refactor-plan.md`、`docs/plans/wave-0-cleanup-and-mechanisms.md`（勾选完成项）

- [x] **Step 1: 全量验收**

Run: `npm run ci:local`
Expected: 13 步全绿（含 `npm test` 全量）。
Run: `npx knip --no-progress` → 零发现；`npm run check:circular` → 零环。

- [x] **Step 2: 回写 spec**

波 0 判据标记达成；存量表更新：Rust dead_code 24 处 → 0（并修正「约 180」表述）、knip 68 项 → 0。

- [x] **Step 3: Commit**

```bash
git add docs/plans && git commit -m "docs(plans): 波 0 验收回写"
```
