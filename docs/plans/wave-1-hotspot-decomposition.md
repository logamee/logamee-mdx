# 波 1：最大热点拆分 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src-tauri/src/commands.rs`（10485 行）按域拆入 `commands/` 目录、把 `src/hooks/useDocumentSession.ts`（2412 行）拆入 `src/features/document/`，两者尺寸基线键清零且行为零变化。

**Architecture:** Rust 侧用「聚合器渐进迁移」：commands.rs 先变为子模块声明 + `pub(crate) use` 再导出，域逐个搬出，lib.rs 与既有测试（`use super::*`）在迁移全程不感知，最后一步才删聚合器。TS 侧用「共享会话上下文 + 子钩子提取」：把回调簇提取为 `features/document/` 下的子钩子，共享的 state/ref 打包为上下文对象传入，`useDocumentSession` 保持返回对象 56 个成员的形状不变。

**Tech Stack:** Rust/Tauri 2、React 19 hooks、TypeScript strict；验证靠既有 585 个 Rust 测试与 1589 行 useDocumentSession 相邻测试。

**Spec:** `docs/plans/code-quality-refactor-plan.md`（v2）「目标架构」「波 1」。

## Global Constraints

- 行为保持红线：搬移提交禁止混入行为修改；IPC 字段、事件名、兼容标识（`mmd-*` 等）零变化。
- `useDocumentSession` 的返回对象形状（56 成员）与 `App.tsx` 解构保持不变。
- 域内文件 ≤300 行；单提交约 400 行，纯搬移超 800 行时 `--no-verify` 并在提交信息注明「纯搬移，`git diff -M` 可验证」。
- 每任务验证：聚焦测试 + `cargo check` 四口径（纯 / `--features packaged-lifecycle-e2e` / `--tests` / feature+tests）或 `npm run typecheck && npm run lint`；波末 `npm run ci:local` 13 步全绿。
- Rust 域清单以实测 38 命令为准：spec 草拟的 export/crash_drafts/workspace_index/html_preview 域已有独立文件（`crash_draft_commands.rs`、`workspace_index_commands.rs`、`html_preview_server.rs`），不建空壳模块（对 spec 模块清单的执行校正）。

## Review Focus

1. **聚合器再导出漏项**——某命令搬出但未在聚合器 `pub(crate) use`，lib.rs 注册或测试编译断裂；每域搬完必须四口径编译（编译器是完备检查）。
2. **可见性放宽**——搬移时把 `fn` 提升为 `pub` 而非 `pub(crate)`，扩大 API 面；只允许 `pub(crate)`，域内私有 helper 保持私有。
3. **共享 helper 归属漂移**——两个域都用的 helper 被复制两份（重复率回潮）；共享项入 `commands/shared.rs` 单份。
4. **子钩子提取改变回调标识**——useCallback 依赖数组变化导致 App 重渲染语义漂移或 effect 重触发；提取前后 `useDocumentSession.test.tsx` 全量跑，依赖数组逐项搬运不重写。
5. **旧路径 re-export 遗漏消费方**——`DocumentSaveConflictDialog`/`ExternalFileChangeDialog` 从旧路径导入的两个接口搬家后失联；grep 消费方并在切换提交中一并更新。

---

## Rust 流：commands.rs → commands/ 七域

聚合器模式：每域任务相同骨架——建 `src-tauri/src/commands/<域>.rs`，搬入命令 + 私有 helper（编译器驱动：搬命令后按报错把缺失项一并搬入或改从 `crate::` 导入），`commands.rs` 顶部加 `mod <域>;` + `pub(crate) use <域>::<每命令名>;`，删除原实现。

### Task 1: settings 域

**Files:** Create `src-tauri/src/commands/settings.rs`；Modify `src-tauri/src/commands.rs`
**Produces:** `commands/settings.rs` 含 `get_settings`、`update_settings`、`reset_settings`、`set_native_save_menu_enabled`、`set_native_theme_preference`、`set_native_locale_preference` 及其私有 helper（≤300 行，超出则拆 `settings/` 目录）。
- [ ] Step 1: 建 `commands.rs` 聚合器骨架（mod + pub(crate) use 声明区）
- [ ] Step 2: 搬 6 个 settings 命令，四口径编译零错零警
- [ ] Step 3: `cargo test` 全绿后提交 `refactor(tauri): 拆出 settings 命令域`

### Task 2: open_recent 域
`open_file_dialog`、`open_workspace_file`、`open_recent_file`、`commit_recent_open`、`get_open_commit_status`、`discard_open_receipt`、`clear_recent_files`（7 命令；含 cfg(test) 会话恢复三件套则一并随迁保持门控）。同 Task 1 骨架，提交 `refactor(tauri): 拆出打开与最近文件命令域`。

### Task 3: document_save 域
`read_file`、`write_file`、`issue_document_overwrite_token`、`retry_document_save_with_token`、`cancel_document_overwrite_token`、`save_as_dialog`（6 命令）。同骨架。

### Task 4: session 域
`persist_workspace_session` + 其恢复/清理 helper（cfg(test) 门控保持）。同骨架。

### Task 5: workspace_mutation 域
`refresh_directory`、`create_workspace_file`、`create_workspace_directory`、`rename_workspace_entry`、`move_workspace_entry`、`copy_workspace_entry`、`reveal_workspace_entry`、`delete_workspace_entry`（8 命令）。同骨架。

### Task 6: media 域
`read_workspace_image`、`resolve_workspace_media`、`prepare_workspace_media_preview`、`prepare_markdown_media_preview`、`release_media_preview`、`resolve_markdown_image`、`resolve_markdown_media`、`read_markdown_excalidraw`（8 命令）。同骨架。

### Task 7: dialogs 域 + 聚合器收尾
`open_directory_dialog`、`open_file_parent_directory`（2 命令）搬出后，`commands.rs` 仅剩：mod 声明、再导出、跨域共享 helper（如有，入 `commands/shared.rs`）、`mod tests`。四口径 + `cargo test` 全绿；提交 `refactor(tauri): commands 聚合器收敛为纯再导出`。

### Task 8: 测试独立 + 删聚合器
`mod tests`（约 6600 行）迁 `commands/tests.rs`（`--no-verify` 纯搬移提交），其 `use super::*` 改为经 `crate::commands::*` 聚合导入；随后删除 `commands.rs`，`lib.rs` 直引各域命令；`check:code-size --update-baseline` 收缩（commands.rs 的 rs-max-lines 键消失）；同提交更新 `AGENTS.md` 项目结构节与 `editor-architecture.md` 实现证据清单。四口径 + `cargo test` + `npm run ci:local` 全绿。

## TS 流：useDocumentSession → features/document/

提取算法（每任务同法）：把回调簇连同其私有 helper 剪切到新文件，包成 `use<X>(ctx: DocumentSessionContext)` 返回同名单回调；ctx 按编译器报错增量收录共享 state/setter/ref；**依赖数组逐项原样搬运**。`src/hooks/useDocumentSession.ts` 改为从新模块导入并保持返回对象 56 成员不变。

### Task 9: 骨架与纯函数下沉
**Files:** Create `src/features/document/sessionFacts.ts`（`activePathInWorkspaceSnapshot`、`editableFileVersion`）、`src/features/document/dialogState.ts`（两个 DialogState 接口）；Modify `src/hooks/useDocumentSession.ts`：这四个符号改为从新模块导入并在旧路径具名 re-export（hook 本体留在原位，至 Task 13 才收敛）。
- [ ] Step 1: 移动纯函数与接口，旧路径 `export *`/具名 re-export
- [ ] Step 2: `npm run typecheck && npx vitest run src/hooks/useDocumentSession.test.tsx`（1589 行测试零改动通过）
- [ ] Step 3: 提交 `refactor(document): 下沉会话纯函数与对话框状态`

### Task 10: openIntent 子模块
`applyOpenFileResponse`、`applyPreparedOpen`、`claimPreparedOpen`、`synchronizeWorkspaceForStandaloneFile`、`openWorkspaceFilePath`、`openWorkspaceIndexResult`、`resolveOpenIntentRequest`、`handleOpenFile`、`handleOpenRecent`、`handleOpenDirectory`（约 508-1474 行簇；目录 `features/document/openIntent/` 内按簇再切 ≤300 行文件）。验证同 Task 9 步骤 2 + `npm run lint`；提交 `refactor(document): 拆出打开意图子模块`。

### Task 11: externalChanges 子模块
`applyExternalDocumentDecision`、`enqueueActiveDocumentWatchEnvelope/Health`、`handleActiveDocumentWatchEvent`、`setExternalFileActionState` 相关簇（`features/document/externalChanges/`）。验证同上；提交 `refactor(document): 拆出外部变更子模块`。

### Task 12: saveFlow 子模块
`saveDocumentAs`、`saveCurrentDocument`、`handleSave`、`handleSaveAs`、`setSaveConflictState`、`lockDocumentAuthorityUnknown` 相关簇（`features/document/saveFlow/`）。验证同上；提交 `refactor(document): 拆出保存与冲突子模块`。

### Task 13: 核心收敛与切换
`useDocumentSession` 核心保留会话状态机/队列/崩溃草稿/窗格复制编排（超 300 行则继续按簇拆文件于 `features/document/core/`）；`App.tsx` 与两个对话框组件切换到 `features/document/` 导入，旧 `src/hooks/useDocumentSession.ts` 若仍超限则评估删除或保留薄 re-export（消费方全切换后删除需同提交更新导入）。`check:code-size --update-baseline` 收缩 useDocumentSession 键；`npm test` 全量 + `npm run ci:local` 全绿；同提交更新 `AGENTS.md` 项目结构节。

## 波 1 完成判据（spec）
- `check:code-size` 基线中 commands.rs 与 useDocumentSession 条目清零。
- `cargo test` 与前端全量测试绿；`ci:local` 13 步全绿。
- 回写 spec 波 1 实测数字与状态。
