# 代码质量彻底重构计划（v2）

本计划以 `AGENTS.md` 全部约束为基准，把代码质量契约从「基线棘轮持有」
推进到「终值达标」。v1 的分阶段路线在此扩展为完整设计；执行粒度由
配套的实施计划（writing-plans 产物）细化。

- 状态：已批准设计（2026-10-03，方案 C：清噪 + 双流交替）
- 基准测量日：2026-10-03
- 门禁机制：见 `docs/testing/validation-matrix.md`「代码质量门禁」

## 终态验收（全部满足才算完成）

1. `npm run check:code-size` 在**空基线**下通过：函数 ≤50 行、
   TS/Rust 源文件 ≤300 行、TS 圈复杂度 ≤10，零存量。
2. Rust 侧 `npm run lint:rust-quality` 以 `-D`（拒绝级）运行零警告：
   `too_many_lines`（≤50 行）与 `cognitive_complexity`（≤10）。
3. `.jscpd.json` 阈值定格 3% 且 `npm run check:duplication` 通过。
4. `npm run check:dead-code`（knip）零发现，并已接入 `ci:local`。
5. 循环依赖检测门禁（波 0 引入）通过并接入 `ci:local`。
6. `npm run test:coverage:changed` 持续通过（新代码行覆盖率 ≥80%；
   全量基准 81.5%，2026-10-03）。
7. `AGENTS.md`、`docs/architecture/editor-architecture.md`、
   `docs/testing/validation-matrix.md` 与实现后的模块结构一致。

## 目标架构

### 前端（领域分组）

```text
src/
  App.tsx        ≤300 行薄壳：组装各域 + 全局协调
  features/
    document/    会话状态、打开意图协调、保存冲突、外部变更
    workspace/   文件树、快照/搜索、回收站交互（FileSidebar 家族迁入）
    preview/     懒加载预览包装、媒体租约、HTML/PDF/DOCX/Excalidraw 策略
    export/      导出对话框、预检、资源内联
    settings/    字号、主题皮肤等设置
    feedback/    appFeedback 模态反馈模型与对话框
  lib/           纯函数（无 React）：markdown*、协议解码、theme、
                 richPaste、crashDrafts、paneSync…
  components/    仅跨域通用组件
  hooks/         收敛目标为空；确属全局的钩子迁入对应 feature
```

- 每个 feature 自带组件、钩子、工具与相邻测试；域内文件 ≤300 行。
- `lib/` 不得 import React；`features/` 域间 import 仅限类型，行为
  复用下沉 `lib/` 或经 App 组装层传递。
- 迁移是渐进的：新目录建立后旧路径保留 `export *` 再导出，消费方
  逐步切换，全部切换后同一提交删除再导出。

### Rust

```text
src-tauri/src/commands/    40 个命令按域拆分：
  open_intent.rs / session.rs / document_save.rs /
  workspace_mutation.rs（创建/改名/移动/回收站）/
  workspace_index.rs / recent_files.rs / settings.rs / export.rs /
  media.rs / html_preview.rs / crash_drafts.rs / dialogs.rs
path_auth/                 authorization / token / snapshot / write_reconcile
html_preview_server/       站点生命周期 / 请求处理 / 授权
```

- `commands.rs` 先变为对各子模块的 `pub use` 聚合，域逐个搬移，
  全部搬完后在同一提交删除聚合文件、`lib.rs` 直引子模块。
- 模块所有权仍以 `docs/architecture/editor-architecture.md` 模块表
  为准；本计划不移动任何逻辑归属，只切分形状。
- 兼容标识（`mmd-*` 事件、`mmd.*` 键、`MMD_*` 等）零改动。

## 执行波次（方案 C）

每波完成判据达成后回写本节的实测数字。Rust 流与 TS 流可交替或
并行；实施计划按波次逐份产出（每波一份，由 writing-plans 生成），
避免单份计划过长。

### 波 0：清噪与机制补强（2026-10-03 完成）

- 删除 knip 全部发现（29 个未使用导出、39 个未使用导出类型），
  `hast` 类型改为显式固定版本依赖（`@types/hast@3.0.5`）；
  `check:dead-code` 接入 `ci:local`。
- 清偿 rustc dead_code 警告：实测 24 处/6 文件（此前「约 180」为
  误记，混入了复杂度警告与重复计数）。处置：真死删除（如
  `read_markdown_file`、孤儿重定位包装函数与死链方法簇）；测试专用
  路径 `#[cfg(test)]` 门控（commands.rs 会话恢复三件套、path_auth
  授权包装方法等）；协议契约成员（`SnapshotReceipt::NotApplicable`、
  `MutationKind::Write`，前端解码器均覆盖）以 `#[allow(dead_code)]`
  保留形状；Windows SDDL 常量 `#[cfg(any(windows, test))]`。
- 引入 TS 循环依赖检测（madge 8.0.0，固定版本）：实测零环，
  直接门禁化接入 `ci:local`。
- 判据达成：`check:dead-code` 零发现并已入 `ci:local`；
  `check:circular` 零环并已入 `ci:local`；尺寸/重复/死代码三项
  测量信号干净。
- 终审修正（同日）：cfg 门控按「测试或 feature 构建」双口径收敛
  （`any(test, feature = "packaged-lifecycle-e2e")`），修复 feature
  构建 4 处编译断裂与 2 处 unused import；`cargo check --features
  packaged-lifecycle-e2e` 已列入验证矩阵 Rust 最低门禁。

### 波 1（Rust A / TS 并行）：最大热点拆分（进行中，2026-10-03）

- Rust：**域拆分已完成主体**——settings、open_recent、document_save
  （4 子模块）、session、workspace_mutation（6 子模块）、media
  （2 子模块）、dialogs 七域迁入 `commands/`，`mod tests`（6590 行）
  独立为 `commands/tests.rs`；`commands.rs` 从 10485 行降至 1211 行
  （-88%）。尾段（fs 平台原语、共享层，约 1130 行）因 cfg(test)
  导入、域声明与平台 cfg 三重交错，脚本化拆分三次错位后裁定中止，
  移交波 3 按平台/共享层人工分步处理；`commands.rs` 的 rs-max-lines
  基线键仍在（对应剩余尾段）。
- TS：**三个子模块已拆出**——`features/document/openIntent.ts`
  （488 行，钉基线）、`externalChanges.ts`（684 行，钉基线）、
  `saveFlow.ts`（341 行）；`useDocumentSession.ts` 从 2412 行降至
  1101 行，保留为会话组合入口。1589 行相邻测试全程零改动通过。
- 判据状态：部分达成（Rust 域化 ✓、TS 三子模块 ✓、两个热点文件
  键清零 ✗——各自剩余核心/尾段钉基线，移交波 3 细分）；每步四口径
  cargo check 0/0、cargo test 585、前端 1175 测试全绿。

### 波 2：界面与后端第二梯队（2026-10-04 完成）

- TS：`App.tsx` 2788→2548——预览包装与媒体重试簇下沉
  `features/preview/`（previewWrappers + mediaRetry），导出流程
  下沉 `features/export/useExportFlow.ts`（pane ref 改惰性 getter
  保持语义）；`FileSidebar`/`FileTreeRows`/`EditorPane` 及相邻测试
  迁 `features/workspace/`。App 媒体回归 29/29、115 App 测试全过。
- Rust：`path_auth.rs` 6798→4158——`tests.rs`（1997）、`fs_paths.rs`
  （45）、`mutation.rs`（447）、`authorization.rs`（225）拆出，
  cfg(test) 门控随迁；`html_preview_server.rs` 3959→2793——
  `http.rs`（394）、`prepare.rs`（831）拆出。GrantLedger 核心状态机
  切分尝试因字段私有强耦合回滚，移交波 3。
- 判据状态：结构性拆分完成；两文件主键（4158/2793 行）仍钉基线，
  连同子模块细分（openIntent 488、externalChanges 684、prepare 831、
  mutation 447）移交波 3 偿还。每步四口径 cargo check 0/0、
  cargo test 585、前端 1175 测试全绿。

### 波 3：长尾文件与函数级偿还

- 剩余 >300 行文件：TS 15 个（tauriCommands 767、richPaste 673、
  theme 672、crashDrafts 650、paneSync 575 等）、Rust 28 个。
- 函数级：TS 66 个超长函数、92 个圈复杂度超标函数（最重：
  `normalizeAppError` 80、`renderNode` 52、`FileSidebar` 48）；
  Rust 43 个认知复杂度超标（最重 `commands.rs:6308` 的 51）+
  1 个超长函数。随所在文件拆分同步偿还，不二次触碰。
- 判据：`check:code-size` 基线清零并可删除基线棘轮；
  `lint:rust-quality` 零警告。

### 波 4：重复率 6.5% → 3%

- 拆分完成后重测 jscpd 获得真实克隆图谱（搬移期失真，故置后）。
- 按簇抽取公共工具，优先 Rust 命令样板与 TS Tauri 调用样板；
  每降 1% 收紧一次 `.jscpd.json` 阈值，至 3% 定格。
- 判据：`check:duplication` 以 3% 阈值通过。

### 波 5：门禁硬化与文档回写

- clippy 两条质量 lint 升 `-D` 并接入 `ci:local`。
- `check:circular`、`check:dead-code` 保持接入；`check:code-size`
  基线文件删除或保留空基线作双保险。
- 回写 `editor-architecture.md` 模块表与实现证据、`AGENTS.md`
  项目结构节、`validation-matrix.md` 门禁清单。
- 判据：终态验收 1–7 全部满足。

## 每步工作法（全波次通用）

- **行为保持红线**：拆分提交禁止混入行为修改；IPC 字段、事件名、
  兼容标识零变化。发现必须改行为的需求时，停下另立变更并按
  AGENTS.md 事实来源规则处理。
- **测试先行**：被搬移单元无相邻测试时，先补特征测试再搬移；
  搬移后聚焦测试 + `npm run ci:local`。
- **提交切分**：单提交约 400 行（>800 钩子拒绝）；基线收缩用
  `--update-baseline` 与拆分同提交，提交信息说明是搬移。
- **验证矩阵**：按变更类型取最低门禁集；Rust 拆分必须含
  `cargo test` 与 `check:platform-apis`，依赖远端四平台 CI 终验。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 拆分期与功能开发并行冲突 | 逐域搬移 + 旧路径再导出缩短窗口；波次不阻塞主干 |
| Windows 路径断言敏感（dcad983 教训） | Rust 每步 `cargo test`；平台差异断言用组件级匹配 |
| 计时测试抖动（aef284d 教训） | 涉时序搬移聚焦 8 连跑后再提交 |
| jscpd 克隆图谱在搬移期失真 | 重复率偿还固定在波 4 |
| 死代码误删（测试专用/保留 API） | 删除前全仓引用检索；保留项写明理由 |
| 测试夹具跨文件导入注册用例 | 波 3 触及 `useEditorFontSize` 时把夹具拆到非测试模块 |

## 维护规则

- 基线只能缩小；任何重建必须在提交信息说明「修复」还是「搬移」。
- 每波完成回写本计划实测数字与判据状态。
- 本计划与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准并回改本计划。

## 存量实测（终态，2026-10-06）

| 维度 | 数字 |
| --- | --- |
| code-size 基线 | 空（`keys: []`）：TS 复杂度/超长函数/大文件与 Rust 大文件零存量 |
| 重复率 | 2.50%（170 克隆），`.jscpd.json` 阈值定格 3.0% |
| 死代码 | knip 零发现（波 0 清零后保持）；Rust 编译警告零 |
| 循环依赖 | 零环；`check:circular` 在 `ci:local` 门禁中 |
| Rust 质量 lint | 184 条（too_many_lines 140 + cognitive_complexity 44）全部清零；`-D` 拒绝级接入 `ci:local`（第 14 道门禁） |
| 覆盖率 | 全量行覆盖基准 81.5%（2026-10-03）；`test:coverage:changed` 通过 |
| 热点榜首 | 重构后 Rust 文件全部 ≤300 行（按原严格阈值），commands.rs 等热点由波 1–3 模块族拆分化解 |

## 完成记录（2026-10-06）

- 波 0–4：基线 207 条 → 0；重复率 6.50% → 2.50%（阈值定格 3.0%）。
- 波 5a：unused import 债务与可见性警告清零（7c139ed）。
- 波 5b：clippy 质量存量 184 条清零——生产 69 条（a3a00c4）、
  测试 115 条（ddfa467），全部行为保持搬移，`#[test]` 数量与名称不变。
- 波 5c：`lint:rust-quality` 升 `-D` 并接入 `ci:local`（09378d4）。
- 阈值调整：2026-10-06 用户决策（752188c）将函数长度阈值放宽至
  80 行、源文件上限至 500 行；波 5b 清零成果在原 50 行/300 行严格
  阈值下复核亦为零，不依赖该放宽。
- 终态验收 1–7 逐条核对通过（证据：`ci:local` 14 道门禁全绿，
  门禁清单见 validation-matrix.md）。

## 目录归位波（2026-10-06，架构评审后续）

按 2026-10-06 架构评审首选建议执行，全部行为保持搬移，四提交完成：

- 设立 `features/settings/`：SettingsDialog 家族 5 文件 +
  `useSettings` + `useEditorFontSize` 迁入；`lib/settings.ts`
  （信封解码）按"协议解码归 lib/"契约留在 lib/。同步偿还已知
  问题：`currentSettingsEnvelope` 夹具拆至非测试模块
  `lib/settingsFixtures.ts`，`useEditorFontSize.test` 用例注册
  26 → 6。
- `hooks/` 清空删除：`useDocumentSession`（组合入口）与崩溃草稿
  恢复 4 文件迁 `features/document/`；窗口/窗格 5 钩子迁
  `features/app/`。
- `components/` 收敛为 `PaneHeader`/`PaneResizer`/`PopoutPaneShell`
  跨域通用件：预览组件、渲染管线（含 `markdown/` 子目录）与媒体
  租约迁 `features/preview/`；工作区对话框、格式面板与 VimLogo 迁
  `features/workspace/`；对话框家族迁 `features/feedback/`；
  ExportDialog 迁 `features/export/`；AppToolbar 与 shell 契约测试
  迁 `features/app/`。
- 文档同步：`AGENTS.md` 项目结构节与
  `editor-architecture.md` 模块表同批回写。
- 判据：每提交 typecheck + 聚焦测试全绿；末次全量 139 文件
  1218 测试、五道质量门禁全绿；重复率 2.51% → 2.50%。

## 已知问题

- ~~`src/hooks/useEditorFontSize.test.tsx` 从 `../lib/settings.test`
  导入共享夹具，被导入文件的用例随导入方一起注册（单文件 26 用例）~~
  （目录归位波已偿还：夹具拆至 `lib/settingsFixtures.ts`，单文件注册
  降为自身 6 用例）。
- `npm run test:perf` 存在 1 项已知失败（与 2026-08-28 快照一致，
  先于本计划存在，不纳入本计划范围）。2026-10-06 定性：
  `evaluate-m3-attestation` 契约测试要求 CI workflow 暴露
  `verify:m3-attestation`，但 `docs/evidence/m3/` 证据文件从未
  提交过仓库（git 全历史为空），属无证据的孤立基础设施，修复需
  先补证据生成流程，不属搬移类重构。
