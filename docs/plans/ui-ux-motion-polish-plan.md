# UI/UX 与动效质感分阶段实施方案书

> 状态：规划中（待按阶段落地）
> 适用项目：`logamee-mdx`（简称 `mdx`）
> 事实来源对齐：[`DESIGN.md`](../../DESIGN.md)、[`AGENTS.md`](../../AGENTS.md)、[`src/styles/themeContract.test.ts`](../../src/styles/themeContract.test.ts)

---

## 1. 背景与总体目标

`mdx` 已经确立了克制、安静、以文档为中心的“纸面工作台”视觉定位，并具备 9 套传统东方纸墨主题和完善的无障碍基础。本方案书聚焦于将界面、交互与动效从“功能完备”推进到“桌面级精致手感”，分三个独立阶段逐步落地：

1. **阶段 1（零依赖修补）**：清零现有样式断层、未定义 CSS 变量、英文硬编码、视口裁切、模糊入场闪烁与光标/过渡不一致问题。
2. **阶段 2（引入 `motion`）**：建立统一动效令牌，补齐弹层退场动画、侧栏折叠与文件树展开的空间连续性、Tab 滑块、换肤柔滑过渡，并打磨分隔条与预览区细节。
3. **阶段 3（按需引入 Radix UI Primitives）**：重构设置中心（分栏导航 + 皮肤/字号实时预览 + 快捷键录制），统一模态框生命周期与焦点管理，增强窄轨侧栏与格式面板的可发现性。

---

## 2. 设计原则与工程红线

在推进全部三个阶段时，必须严格遵守以下约束：

- **审美一致性**：延续“纸面工作台”调性，拒绝重型强视觉组件库（如 AntD/MUI）和通用 SaaS 卡片墙；不引入 CSS 渐变（`linear/radial/conic-gradient`）与内容区 `filter`（`themeContract.test.ts` 硬性校验）。
- **令牌单一事实来源**：
  - 9 套皮肤块内的变量集合必须与 `src/styles/themeTokens.ts` 中的 `CANONICAL_THEME_TOKENS` 严格一致。
  - 新增动效令牌（`--motion-*`、`--ease-*`）必须定义在 `src/styles/base.css` 的通用 `:root` 中，不得混入各皮肤块。
  - 若新增色彩令牌，必须同步更新 `themeTokens.ts`、全部 10 个皮肤块及 `themeContract.test.ts`。
- **兼容面与安全边界**：不得修改 `mmd-*` 兼容类名/事件名/存储键；不得放宽 Tauri CSP、路径授权或破坏性弹窗确认逻辑。
- **无障碍与感官降级**：全量动效自动响应 `prefers-reduced-motion: reduce`；破坏性/冲突类对话框（未保存退出、保存冲突、外部变更、崩溃恢复）不因误点遮罩而静默关闭。
- **代码质量门禁（`AGENTS.md`）**：
  - 单次提交建议控制在 400 行以内（上限 800 行）；每阶段可按需拆为 1–2 个干净提交。
  - 单函数 ≤ 80 行、单源文件 ≤ 500 行、单函数圈复杂度 ≤ 10（`npm run check:code-size`）。
  - 新增/修改代码行覆盖率 ≥ 80%（`npm run test:coverage:changed`），遵循 TDD（先写/更新失败测试，再改实现）。

---

## 3. 第三方依赖选型与引入策略

| 阶段 | 拟引入包 | 用途与定位 | 选型理由 |
| :--- | :--- | :--- | :--- |
| **阶段 1** | 无 | 纯 CSS / TS 修补 | 零风险、快速收敛存量视觉缺陷 |
| **阶段 2** | `motion` | `motion/react`（`LazyMotion` + `domAnimation` + `AnimatePresence` + `MotionConfig`） | 用于弹窗退场和系统减动效适配。侧栏的两个等宽标签通过 CSS 移动同一个指示器。 |
| **阶段 3** | `@radix-ui/react-dialog`<br>`@radix-ui/react-tabs`<br>`@radix-ui/react-switch`<br>`@radix-ui/react-slider` | 零样式无障碍交互原语 | 100% 复用现有 9 套皮肤 Token；开箱提供焦点陷阱、ESC/遮罩关闭、键盘导航与 `forceMount` 退场动画衔接 |

> 引入新依赖后，执行 `npm install` 会通过 `postinstall` 自动运行 `npm run sync:third-party-notices`，提交时须同步包含 `package.json`、`package-lock.json` 与更新后的第三方许可声明文件。

---

## 4. 阶段 1：视觉缺陷清零与交互一致性修补（零依赖）

**预计改动体量**：约 180–280 行（1 个提交）。

### 4.1 任务拆解

1. **修复编辑器右键菜单的样式断层、国际化与视口防裁切**
   - **目标文件**：`src/styles/app-shell.css`、`src/features/workspace/editorPaneContextMenu.tsx`、`src/lib/i18n.tsx`
   - **具体改动**：
     - 将 `.editor-context-menu` 中未定义的 `--panel-bg` / `--text` / `--hover-bg` 替换为标准令牌 `--panel-strong` / `--chrome-text` / `--control-hover`，并将圆角（`8px` / `5px`）、毛玻璃（`backdrop-filter: blur(22px) saturate(150%)`）、悬浮高亮（`--accent` 填底 + `--accent-foreground` 反色文字）和入场动画（`shell-menu-in`）与 `.file-tree-context-menu` 完全统一。
     - 将 `EDITOR_CONTEXT_MENU_ITEMS` 的硬编码英文标签全部接入 `src/lib/i18n.tsx`（中英文补齐）。
     - 修正 `clampContextMenuPosition`，结合菜单实际/预估高度（或在挂载后用 `getBoundingClientRect()` 校正）避免靠近窗口底部时菜单被截断。
2. **去除弹窗入场的 `filter: blur(4px)` 闪烁**
   - **目标文件**：`src/styles/app-shell.css`
   - **具体改动**：将 `@keyframes shell-materialize-in` 调整为纯合成层动画：`opacity: 0 -> 1` 与 `transform: translateY(-6px) scale(0.985) -> translateY(0) scale(1)`，时长由 `280ms` 收敛为 `200ms`，消除 WebView 下文字模糊闪烁。
3. **统一交互微过渡与指针手型**
   - **目标文件**：`src/styles/app-shell.css`、`src/styles/markdown-preview.css`
   - **具体改动**：
     - 为 `.toolbar-icon-button`、`.settings-launch-button`、`.outline-item`、`.settings-skin-option`、`.workspace-search-result`、`.code-copy-button` 补齐 `background-color`、`border-color`、`color` 的 `120ms ease-out` 过渡。
     - 为 `.workspace-image` 与 `.workspace-video` 增加 `transition: opacity 180ms ease-out`，消除加载完成瞬间的硬闪。
     - 修正 `.tree-row:not(.disabled):not(.renaming)` 的默认光标，去掉平时态 `cursor: grab`，改为常规指针，仅在 `.tree-row.dragging` 时使用 `cursor: grabbing`。
     - 统一应用内按钮光标规范（与原生桌面风格一致，避免同一工具栏混用 `pointer` 与 `default`）。
4. **顶部工具栏与编辑器状态栏细节微调**
   - **目标文件**：`src/features/app/AppMainWindow.tsx`、`src/features/app/AppToolbar.tsx`、`src/styles/app-shell.css`、`src/styles/responsive.css`
   - **具体改动**：
     - 将 `.settings-launch-button` 收编进 `AppToolbar` 右侧操作区（与 `.document-status` 同处右侧 Grid 列并排对齐），去掉外部绝对定位与 `.toolbar` 的硬编码 `padding-right: 52px`。
     - 编辑器状态栏字号按钮 `.editor-status-font-button` / `.editor-status-font-value` 高度由 `18px` 提升至 `22px`（状态栏高度同步微调至 `28px`），改善点击热区。

### 4.2 TDD 测试与验证清单（阶段 1）

- **新增/更新测试**：
  - `src/features/workspace/editorPaneContextMenu.test.tsx`（或现有编辑器面板测试）：验证中英文文案渲染、靠近视口底部时坐标防溢出。
  - `src/styles/themeContract.test.ts`：补充断言确保 `app-shell.css` 中不再引用未定义令牌（`--panel-bg`、`--hover-bg`、`--text`）且 `.editor-context-menu` 走标准令牌。
  - `src/features/app/shellStructure.test.tsx`：确认设置入口并入 `AppToolbar` 后语义、禁用态与点击回调保持不变。
- **验证命令**：
  ```bash
  npm test
  npm run typecheck
  npm run lint
  npm run check:code-size
  npm run test:coverage:changed
  ```

---

## 5. 阶段 2：动效体系建设与空间/视觉质感升级（引入 `motion`）

**预计改动体量**：约 300–450 行（建议拆为 2 个小提交：2A 动效底座与弹层、2B 布局动效与视觉细化）。

### 5.1 任务拆解

1. **建立动效令牌与 `motion` 运行底座（提交 2A）**
   - 安装 `motion` 并同步 `npm run sync:third-party-notices`。
   - 在 `src/styles/base.css` 通用 `:root` 中新增标准动效令牌：
     ```css
     --motion-fast: 100ms;
     --motion-base: 160ms;
     --motion-slow: 220ms;
     --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
     --ease-exit: cubic-bezier(0.4, 0, 1, 1);
     --ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
     ```
   - 在 `src/App.tsx` 使用 `<LazyMotion features={domAnimation}>` 与 `<MotionConfig reducedMotion="user">`。
   - `src/lib/motionPresets.ts` 定义弹窗遮罩的淡入淡出，弹窗卡片的缩放与位移使用 CSS。
2. **统一弹窗与浮层的“进场 + 退场”动画（提交 2A）**
   - **目标文件**：`src/features/feedback/AppDialogStack.tsx`、`src/features/workspace/MarkdownFormatDialog.tsx`、`src/features/workspace/fileSidebarContextMenu.tsx`、`src/features/workspace/editorPaneContextMenu.tsx`
   - **具体改动**：
     - 在 `AppDialogStack` 外层接入 `<AnimatePresence mode="wait">`，为各模态框分配稳定 `key`，实现 `180ms` 进场 + `120ms` 退场（淡出 + `scale: 0.985`），彻底消除关闭时的“硬消失”。
     - 右键菜单、侧栏添加菜单和格式面板沿用各自的交互生命周期，本次保留 CSS 入场效果。
3. **高频布局的空间连续性动效（提交 2B）**
   - **文件夹展开/折叠**（`src/features/workspace/FileTreeRows.tsx`、`src/styles/app-shell.css`）：
     - 将 `<ChevronRight>` / `<ChevronDown>` 硬切换改为单个 `<ChevronRight>` 配合 `transform: rotate(90deg)` 的 `150ms` 过渡。
     - 子级分支展开时增加极轻的透明度与微位移入场（避免在大目录树下做昂贵的 `height: auto` 布局重排，确保 10k 节点性能不退化）。
   - **侧边栏收起/展开平滑过渡**（`src/features/workspace/WorkspaceMainArea.tsx`、`src/features/app/useWorkspaceSidebarResize.ts`、`src/styles/app-shell.css`）：
     - 在点击收起/展开按钮时给 `.workspace` 启用 `grid-template-columns` 过渡（`180ms`）；在指针拖拽调整宽度期间通过 `.is-resizing` 类关闭过渡，保持 1:1 零延迟跟手。
   - **侧栏「文件 / 大纲」Tab 共享滑块**（`src/features/workspace/fileSidebarPanelsView.tsx`）：
     - 在标签栏内保留一个指示器。切换视图时用 CSS 平移一个标签宽度加列间距，键盘和鼠标切换共用相同的过渡。
   - **主题皮肤柔滑切换**（`src/lib/theme.ts`、`src/styles/base.css`）：
     - 切换皮肤时在 `document.documentElement` 临时挂载 `data-theme-transitioning="true"`（约 200ms 后自动移除），仅在该窗口内对表面 `background-color`、`color`、`border-color` 启用 `180ms ease-out` 过渡。
4. **视觉质感打磨（提交 2B）**
   - **分隔拖拽条微手柄**（`src/components/PaneResizer.tsx`、`src/styles/app-shell.css`）：默认态居中渲染 `2px × 24px` 极淡圆角胶囊指示条，hover/focus 时平滑伸长至 `36px` 并高亮 `--accent`；支持双击重置 `editorPaneRatio` 为 `0.5`。
   - **预览区阴影柔化**（`src/styles/markdown-preview.css`）：将 `blockquote` 与行内 `code` 的硬投影替换为克制的 `1px solid` 细描边与底色层次。
   - **文件树图标色彩降噪**：将 `app-shell.css` 中刺眼的硬编码图标色调整为低饱和度、明暗模式双适配的协调色阶。
   - **待确认项**：是否同步提亮 `original` 深色正文 `--text-reading` / `--editor-text`（从 `#a1a1aa` 调至 `#d4d4d8`）并更新 `themeContract.test.ts` 中的对应断言。

### 5.2 TDD 测试与验证清单（阶段 2）

- **新增/更新测试**：
  - `src/lib/motionPresets.test.ts`：验证动效预设时长与缓动契约。
  - `src/components/PaneResizer.test.tsx`：验证双击重置 50/50 比例回调。
  - `src/features/workspace/FileSidebar.test.tsx` / `App.outline.test.tsx`：验证单箭头 `aria-expanded` 态、Tab 切换及大纲面板在 `MotionConfig` 下正常交互（无卸载竞态）。
  - `src/styles/themeContract.test.ts`：验证通用 `:root` 动效令牌不破坏 9 套皮肤契约且无违规渐变/滤镜。
- **验证命令**：
  ```bash
  npm test
  npm run typecheck
  npm run lint
  npm run check:code-size
  npm run check:dead-code
  npm run check:circular
  npm run build
  ```

---

## 6. 阶段 3：设置中心重构与 Radix Primitives 交互升级

**预计改动体量**：约 450–650 行（建议拆为 2 个独立提交：3A Radix 基础原语与模态框统一、3B 设置中心重构与侧栏/编辑器快捷入口）。

### 6.1 任务拆解

1. **安装并封装 Radix UI 无样式原语（提交 3A）**
   - 安装 `@radix-ui/react-dialog`、`@radix-ui/react-tabs`、`@radix-ui/react-switch`、`@radix-ui/react-slider`，并同步第三方许可声明。
   - 在 `src/components/primitives/` 下建立极薄的样式封装层（完全映射现有 CSS 变量，不新建平行令牌）：
     - `ModalDialog.tsx`：封装 `Dialog.Root` + `Dialog.Portal` + `Dialog.Overlay` + `Dialog.Content`，结合 `forceMount` 与 `AnimatePresence` 实现统一进退场、焦点陷阱、触发焦点恢复、以及可配置的 `dismissible`（普通弹窗允许点击遮罩/`Escape` 关闭；破坏性/冲突弹窗设为 `dismissible={false}` 防止误关）。
     - `SwitchControl.tsx`：替代原生 `<input type="checkbox">` 的设置开关，呈现平滑轨道与圆钮位移过渡。
     - `SliderControl.tsx`：替代原生 `<input type="range">`，用于编辑区比例等连续值调节，带实时百分比数值显示。
   - 将 `WorkspaceSearchDialog`、`ExportDialog`、`FeedbackDialog`、`SettingsDialog` 逐步迁移至统一 `ModalDialog` 壳体。
2. **重构设置中心 `SettingsDialog`（提交 3B）**
   - **目标文件**：`src/features/settings/SettingsDialog.tsx`、`src/features/settings/settingsDialogSections.tsx`、`src/features/settings/settingsShortcutRecorder.tsx`（新建）、`src/styles/app-shell.css`、`src/styles/responsive.css`
   - **架构拆分**（确保每个文件 ≤ 500 行、每个函数 ≤ 80 行）：
     - 采用 `@radix-ui/react-tabs`（`orientation="vertical"`，窄屏 `< 640px` 自动退化为顶部横向 Tab）将设置分为 4 个清晰分组：
       1. **常规与保存**：自动保存开关、触发方式、延迟时间、拼写检查、双链开关。
       2. **外观与排版**：9 套纸墨皮肤色板网格、跟随系统明暗、编辑器字号、界面语言。
       3. **快捷键**：独立快捷键录制列表 + 冲突检测提示 + 一键恢复默认。
       4. **资源与索引**：资源目录授权路径、编辑区默认比例滑块、工作区索引重建/丢弃。
     - **皮肤与字号实时预览（Live Preview）**：在设置弹窗内切换皮肤或调整字号时，即时应用预览到根节点；点击「保存」固化设置，点击「取消」/`Escape`/遮罩关闭时自动回滚至打开弹窗前的快照，不触发后端写入或冲突流程。
     - **快捷键录制器（Key Recorder）**：点击快捷键输入框进入录制态，按下组合键（如 `Cmd/Ctrl + Shift + P`）自动规范化写入 `AppSettings.shortcuts`，按 `Escape` 退出录制，并实时复用现有 `findShortcutConflicts` 校验。
3. **补强高频入口的可发现性（提交 3B）**
   - **折叠态侧栏窄轨**（`src/features/workspace/fileSidebarChromeView.tsx`）：在 46px 窄轨上补充「文件树」「大纲」「快速打开」三个图标按钮；点击「文件树」或「大纲」直接展开侧栏并切至对应视图，点击「快速打开」直接唤起搜索窗。
   - **编辑器格式面板显式入口**（`src/features/workspace/editorPaneView.tsx`）：在 `PaneHeader` 的 Vim 按钮旁增加一个克制的格式命令图标按钮（tooltip 标注长按左 Ctrl / 点击打开），降低新用户的发现门槛。

### 6.2 TDD 测试、文档同步与最终验收（阶段 3）

- **新增/更新测试**：
  - `src/features/settings/SettingsDialog.test.tsx`：覆盖 4 个分栏切换、皮肤/字号实时预览与取消回滚、快捷键录制器输入与冲突拦截、遮罩/`Escape` 关闭。
  - `src/features/app/shellDialogs.test.tsx`：验证普通弹窗支持遮罩/`Escape` 关闭，而未保存退出/保存冲突弹窗拒绝误点遮罩关闭。
  - `src/features/workspace/FileSidebar.test.tsx`：覆盖窄轨状态下点击大纲/文件快捷按钮展开并切换视图。
- **文档同步**：更新 [`DESIGN.md`](../../DESIGN.md) 中关于动效令牌、设置弹窗分栏与实时预览、编辑器格式面板显式入口及窄轨侧栏的描述。
- **全量验证矩阵（`docs/testing/validation-matrix.md`）**：
  ```bash
  npm test
  npm run typecheck
  npm run lint
  npm run check:code-size
  npm run check:duplication
  npm run check:dead-code
  npm run check:circular
  npm run test:coverage:changed
  npm run build
  cargo test --manifest-path src-tauri/Cargo.toml
  ```
- **人工视觉抽检矩阵**：在宽屏（1440×900）、中屏（920×650）、窄屏（600×700）下，分别抽检 `original`（明/暗）、`gujuan-nuanxing`（暖纸）和 `shanshui-yemo`（深色）皮肤的弹窗进退场、右键菜单定位、侧栏折叠、设置实时预览与 `prefers-reduced-motion` 降级表现。

---

## 7. 执行进度跟踪

- [x] **阶段 1**：右键菜单修复与全站基础交互/过渡统一
- [x] **阶段 2A**：引入 `motion`、动效令牌与弹层进退场动画
- [x] **阶段 2B**：布局连续性动效、分隔条微手柄与预览区质感细化
- [x] **阶段 3A**：引入 `@radix-ui/react-tabs` 与统一遮罩/`Escape` 关闭体验
- [x] **阶段 3B**：`SettingsDialog` 分栏/实时预览/快捷键录制重构 + 窄轨与格式入口增强
