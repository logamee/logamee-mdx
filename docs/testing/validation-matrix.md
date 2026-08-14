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
| Rust 文件/授权/写入/回收站 | 对应 Rust 测试、`cargo check --manifest-path src-tauri/Cargo.toml` | 根目录逃逸、符号链接、版本冲突、持久写入、不确定结果 |
| Tauri 配置/窗口/CSP/文件关联 | `npm test`、Rust 测试、`npm run build`、必要时 `npm run tauri -- build --debug` | 最小能力权限、CSP、启动/第二实例/窗口释放 |
| 性能/索引 | `npm run perf:gate` | 10k/100k 产物完整、可比较、p95 门禁结果 |
| 发布脚本/版本/第三方资产 | `npm run test:release-tools`、`npm run check:release-version`、`npm run sync:vendor-assets` | 版本、信任、产物、平台冒烟测试、许可证和资源清单 |

## 常用验证序列

依赖顺序按以下方式执行，失败后先修复再运行下游：

```bash
git diff --check
npm test
npm run typecheck
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

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
- 未来交付 Markdown 音视频内嵌时，补充兼容语法、文档身份与资源授权、
  支持/不支持格式、加载失败、键盘与字幕/文本替代、离线与导出降级，以及
  Linux/macOS/Windows 播放回归；路线图条目本身不计为能力通过；
- HTML iframe 沙箱/本地预览服务、离线 HTML DOMPurify、DOCX 白名单、
  PDF 页面/缩放；
- 导出预检、资源内联、目标冲突和取消不改变当前保存状态。

### 界面与可访问性

- 已保存/已编辑/工作中、加载/空/错误/禁用状态的文字和图标语义；
- 文件树/大纲键盘导航、对话框焦点恢复、纯图标控件标签；
- 原始主题/主题皮肤 + 明暗模式、`prefers-reduced-motion`、980/640px 布局；
- 主窗口与独立窗口的事件重试、关闭释放和重复点击聚焦。

## 发布与环境限制

- `scripts/ci/` 提供 Linux/macOS/Windows 冒烟测试和证据脚本；当前检出内容
  未包含 `.github/workflows/`，因此依赖这些文件的发布工作流契约测试不可用，
  本地也不能宣称远端 CI 工作流已执行或发布门禁完整通过。
- 截至 2026-08-14，在当前检出内容中，`npm run test:perf` 的脚本测试为
  41 项通过、1 项失败，
  失败项是读取缺失的 `.github/workflows/platform-ci.yml`；
  `npm run test:release-tools` 的工作流契约子测试同样因缺失
  `.github/workflows/platform-ci.yml` 或 `release.yml` 失败。其余不依赖工作流
  文件的脚本测试仍可作为局部证据，不能把整条门禁标为通过。
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
