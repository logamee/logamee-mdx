# 验证矩阵

本矩阵适用于 logamee-mdx（简称 mdx）。

## 目的

验证不是“能编译”这一项。每次变更根据影响面选择最低门禁，并在交付说明
中记录实际命令、结果和未运行项。若行为涉及多个边界，取所有相关行的并集。

## 最低门禁

| 变更类型 | 最低命令 | 必须检查的行为 |
|---|---|---|
| 纯文档/注释 | `git diff --check` | 链接、命令、状态和事实未过期 |
| React/CSS/主题/交互 | 聚焦 Vitest、`npm run typecheck`、`npm run lint` | 组件状态、键盘/ARIA、主题令牌、窄屏布局 |
| Markdown/预览/导出 | 对应 Vitest、`npm run typecheck`、`npm run build` | 围栏代码、GFM/数学、资源作用域、HTML iframe 沙箱、DOCX/富文本净化器、导出预检 |
| IPC/协议/工作区 | 对应 Vitest + `cargo test --manifest-path src-tauri/Cargo.toml` | 精确键解码、世代编号/令牌、回执、错误路径 |
| Rust 文件/授权/写入/回收站 | 对应 Rust 测试、`cargo check --manifest-path src-tauri/Cargo.toml`、`cargo check --manifest-path src-tauri/Cargo.toml --features packaged-lifecycle-e2e`、`npm run check:platform-apis` | 根目录逃逸、符号链接、版本冲突、持久写入、不确定结果；平台专有 API（`std::os::unix`/`std::os::windows`、`libc::`、平台 crate）必须位于平台 cfg 门控内 |
| Tauri 配置/窗口/CSP/文件关联 | `npm test`、Rust 测试、`npm run build`、必要时 `npm run tauri -- build --debug` | 最小能力权限、CSP、启动/第二实例/窗口释放 |
| 性能/索引 | `npm run perf:gate` | 10k/100k 产物完整、可比较、p95 门禁结果 |
| 发布脚本/版本/第三方资产 | `npm run test:release-tools`、`npm run check:release-version`、`npm run sync:vendor-assets` | 版本、信任、产物、平台冒烟测试、许可证和资源清单 |
| 代码质量门禁脚本/基线 | `npm run test:code-quality`、`npm run check:code-size` | 棘轮只减不增；基线重建必须说明理由 |

## 常用验证序列

依赖顺序按以下方式执行，失败后先修复再运行下游：

```bash
git diff --check
npm test
npm run typecheck
npm run lint
npm run check:code-size
npm run check:duplication
npm run check:dead-code
npm run check:circular
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --features packaged-lifecycle-e2e
cargo test --manifest-path src-tauri/Cargo.toml
```

上述序列可通过一条命令运行（失败即停，平台 API 审计在序列前段）：

```bash
npm run ci:local
```

`npm run check:platform-apis` 是静态门禁纪律审计：扫描 `src-tauri` 中的
`std::os::unix`、`std::os::windows`、`libc::` 与平台专有 crate 引用，要求其
位于 `cfg(unix)`、`cfg(windows)`、`cfg(target_os = ...)` 等平台门控内，防止
"仅在一台开发机上编译过"的跨平台编译破坏（例如只在 `cfg(test)` 下使用
Unix 专有导入）。它不能模拟编译：导入可见性类偏差（如门控导入被
`cfg(test)` 代码引用）仍需远端四平台 CI 确认；个别行可用
`platform-audit: allow` 注释显式豁免并说明理由。

涉及脚本/元数据时追加：

```bash
npm run test:metadata
npm run test:release-version
npm run test:release-tools
```

涉及性能时追加：

```bash
npm run test:perf
npm run perf:gate
```

## 代码质量门禁

量化阈值定义在 `AGENTS.md`「代码质量与防腐约定」；存量违规的偿还
计划见 [`../plans/code-quality-refactor-plan.md`](../plans/code-quality-refactor-plan.md)。
前六项已包含在 `npm run ci:local`：

- `npm run check:code-size`：函数 ≤80 行、源文件 ≤500 行、圈复杂度
  ≤10 的基线棘轮。存量违规钉在 `scripts/ci/baselines/code-size.json`，
  只减不增；新增违规立即失败。基线收缩或搬移后用
  `npm run check:code-size -- --update-baseline` 重建并在提交中说明理由。
- `npm run test:code-quality`：上述门禁脚本自身的契约测试。
- `npm run check:duplication`：jscpd 重复率棘轮，阈值在 `.jscpd.json`
  （已定格 3%，存量 2.5%）。
- `npm run check:dead-code`：knip 死代码检查，配置 `knip.config.ts`。
- `npm run check:circular`：dpdm 循环依赖检查，覆盖 `src`、`scripts`
  与根配置的 TS/TSX/MJS，零环即通过。
- `npm run lint:rust-quality`：clippy 函数长度（≤80 行）与认知复杂度
  （≤10）检查，拒绝级（`-D`），阈值在 `src-tauri/clippy.toml`。
- `npm run test:coverage:changed`：改动文件行覆盖率 ≥80%（老账先认、
  新账不欠）；无改动时静默通过。全量趋势报告用 `npm run test:coverage`。
- `npm run report:hotspots`：提交频次 × 当前行数的热点报告，信息性
  输出，用于评审与重构排优先级。

提交钩子（`.husky/`，`npm install` 后经 `prepare` 脚本激活）：
pre-commit 运行提交幅度检查（>400 行提示、>800 行拒绝）、staged
文件 lint、全量 typecheck 与代码尺寸棘轮；pre-push 运行
`npm run ci:local`。绕过必须显式使用 `--no-verify` 并在交付说明中
记录原因。

## 领域回归清单

### 文档与工作区

- 打开入口（对话框、文件关联/命令行、拖放、最近文件、第二实例、会话恢复）
  的去重、聚焦和非法路径反馈；
- 编辑/保存/外部修改/冲突/未保存退出/崩溃草稿状态；
- 创建、重命名、移动、删除、回收站结果和过期快照修复；
- 工作区索引的取消、世代编号、过期结果丢弃和边界数量。

### 内容与预览

- Markdown 围栏代码、GFM 表格、数学、引用块、Mermaid 和代码复制；
- 相对图片/媒体/Excalidraw 资源的作用域、失败回退和插入握手；
- Markdown 视频内嵌的图片样式语法、文档身份与资源授权、支持格式矩阵、
  FLV/MPEG-TS 播放路径、加载失败、键盘控制、离线与导出回退；真实
  Linux/macOS/Windows 播放回归仍需平台机器证据；音频正文内嵌仍属计划；
- HTML iframe 沙箱/本地预览服务、离线 HTML DOMPurify、DOCX 白名单、
  PDF 页面/缩放；
- 导出预检、资源内联、目标冲突和取消不改变当前保存状态。

### 界面与可访问性

- 已保存/已编辑/工作中、加载/空/错误/禁用状态的文字和图标语义；
- 文件树/大纲键盘导航、对话框焦点恢复、纯图标控件标签；
- 原始主题/主题皮肤 + 明暗模式、`prefers-reduced-motion`、980/640px 布局；
- 主窗口与独立窗口的事件重试、关闭释放和重复点击聚焦。

## 发布与环境限制

- `.github/workflows/platform-ci.yml` 在 pull request、push 和手动触发时运行
  前端门禁，并分别构建 macOS arm64、macOS x64、Windows x64 和 Linux x64
  安装包。基础产物只有在对应平台完成安装、启动、文件关联和生命周期冒烟
  验证后，才会以 `-verified` 名称再次上传；工作流权限保持只读且不发布
  GitHub Release。
- `.github/workflows/release.yml` 在主线 push 或手动触发时构建四个平台，先执行
  非 instrumented 安装包冒烟，再以 `Latest` Release 发布。缺少完整生产信任
  秘钥时会明确回退到 unsigned 安装包并关闭 updater；配置齐全时才生成签名
  产物和 `latest.json`。本地工作流契约通过也不能替代远端 GitHub Actions 的
  真实四平台运行结果。
- 截至 2026-10-03（波 0 完成后），`node --test scripts/ci/*.node-test.mjs`
  为 151 项通过、5 项按平台跳过、0 项失败（含代码质量门禁脚本契约）。
  `npm run test:perf` 仍为 41 项通过、1 项失败，`npm run test:release-tools`
  为 138 项通过、5 项按平台跳过、0 项失败；
  这些本地契约测试不能替代远端四平台构建、冒烟和发布结果。
- 需要真实 Tauri 窗口、文件关联或视觉验收时，记录操作系统、窗口尺寸、
  Rust 工具链、是否启用 `packaged-lifecycle-e2e`，以及人工检查结果。
- 不使用未经项目约定的浏览器自动化或 CDP 作为唯一安全/桌面生命周期证据；
  用现有单测、Rust 测试、脚本契约和调试构建组成证据链。
- 性能基线详情和通过/失败/不可比较语义见
  [`../performance-baselines.md`](../performance-baselines.md)。

## 交付证据格式

交付或评审记录至少包含：

1. 变更影响的文档/代码边界；
2. 运行过的命令和通过/失败摘要；
3. 未运行门禁及其原因；
4. 若安全、协议、设计或产品行为改变，指向更新后的归属文档和
   回归测试；
5. 仍待产品/工程决策的待决问题，而不是用默认实现替代决策。
