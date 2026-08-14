# logamee-mdx（简称 mdx）项目智能体说明

本仓库是 mdx，一个本地优先的 Tauri 2 Markdown 桌面编辑器。仓库使用一组
稳定文档作为实现与评审的事实来源。修改前先阅读对应文档，不得根据单个
组件自行推导新的产品或安全契约。

## 开始前必读

- 项目规则索引：`.codex/rules/project-rules.md`
- 产品与视觉契约：`DESIGN.md`
- 文档索引：`docs/README.md`
- 架构边界：`docs/architecture/editor-architecture.md`
- 文件与资源安全契约：`docs/constraints/security-and-file-access.md`
- 文档生命周期规范：`docs/specs/document-lifecycle.md`
- 验证矩阵：`docs/testing/validation-matrix.md`

## 工作契约

- 变更范围必须与用户请求一致，并兼容本地优先的桌面产品模型。除非用户
  明确调整产品边界，否则不得加入云同步、账号、遥测或服务端接口。
- 引入新抽象或依赖前，优先复用现有组件、钩子、协议解码器、Rust 命令和
  标准主题令牌。
- 所有文件系统路径、工作区令牌、IPC 载荷和二进制预览都属于安全敏感面；
  修改前必须遵守安全契约。
- 现有 `mmd-*` 事件名、`mmd.*` 存储键、`.mmd-*` CSS 类、`mmd:embed` /
  `mmd:source` 格式标记、`MMD_*` 环境变量和 `local.mmd.editor` 应用标识符
  都是兼容标识。除非已有明确迁移设计、兼容测试和回滚方案，否则不得随
  项目或产品改名而修改。
- 必须区分“确认已提交”“确认未提交”和“结果不确定”。不得把无法确认的
  写入、重命名、移动或回收站操作静默显示为成功。
- 面向用户的通知、警告和错误统一进入共享模态反馈模型。显示前先转换
  Tauri 或运行时技术错误；不得新增顶部提示条、常驻通知、裸
  `window.confirm` 或内联技术错误转储。
- 新行为和缺陷修复使用测试驱动开发：先新增或更新能够捕获契约的最小测试，
  再运行聚焦检查，最后实施和重构。
- 不得提交密钥或生成产物。运行时和本地状态必须放在已忽略文件中；不得
  直接修改 `dist/`、`node_modules/` 或 `src-tauri/target/`。
- 声明完成前必须验证，并明确报告已运行命令和验证缺口。没有用户明确要求时，
  不得发布、打包或修改发布与更新信任材料。

## 文档与能力路由

先找到拥有该决策的文档；实现揭示矛盾时，同步修正文档：

- 产品、界面、用户体验、字体、主题、响应式和无障碍：`DESIGN.md`
- 前端与编辑器状态、面板归属、懒加载预览和 IPC 顺序：
  `docs/architecture/editor-architecture.md`
- Markdown 预处理，HTML、Excalidraw、媒体、PDF、DOCX 预览和导出行为：
  `docs/specs/document-lifecycle.md`
- Tauri 命令、工作区授权、路径归一化、资源服务、写入、回收站和 CSP：
  `docs/constraints/security-and-file-access.md`
  （HTML 预览依赖沙箱和本地服务隔离，不是通用 DOM 净化器。）
- 测试、发布检查、性能门禁和证据报告：
  `docs/testing/validation-matrix.md`
- 新增或移动指导文档时，必须在同一变更中更新 `docs/README.md` 和
  `.codex/rules/project-rules.md`。

## 事实来源与优先级

`AGENTS.md` 定义工作契约，`DESIGN.md` 定义用户可见的设计决策，
`docs/` 下的文档定义行为与技术不变量，源码和测试提供当前实现证据。
实现与文档不一致时，不得静默选择其中一个：先判断行为是意外还是有意，
必要时补充回归测试，并在同一变更中更新归属文档。更高优先级的系统和
开发者指令始终有效。

## 项目结构与模块组织

本仓库使用 React、TypeScript、Vite 和 Tauri 2 构建 Markdown 桌面编辑器。

- `src/` 包含 React 前端。`App.tsx` 协调编辑器界面，`components/`
  存放可复用界面和预览组件，`hooks/` 管理会话和窗口生命周期，
  `lib/` 存放 Markdown 预处理、协议和领域工具，`types.ts` 存放共享
  前端契约。
- `src-tauri/` 包含 Rust 后端。Tauri 命令、文件系统授权、目录遍历、
  持久写入、崩溃草稿、工作区索引及测试位于其 Rust 模块中；`lib.rs`
  负责组装 Tauri 应用。
- `public/styles/typora-theme/` 存放迁移后的 Typora/Jinxiu 预览资源。
- `src-tauri/capabilities/`、`src-tauri/tauri.conf.json` 和
  `src-tauri/icons/` 定义权限、CSP 与资源访问、打包元数据和图标。
- `dist/`、`node_modules/` 和 `src-tauri/target/` 是生成目录，不得
  直接修改。

## 构建、测试与开发命令

- `npm install`：安装前端依赖和 Tauri 命令行工具。
- `npm run dev`：启动 Vite 前端开发服务器。
- `npm run typecheck`：执行 TypeScript 类型检查且不生成文件。
- `npm test`：使用 Vitest 运行前端单元测试。
- `npm run lint`：使用 Oxlint 检查 React、无障碍和 Vitest 规则。
- `npm run build`：完成类型检查并生成生产前端构建。
- `cargo test --manifest-path src-tauri/Cargo.toml`：运行 Rust 单元测试。
- `cargo check --manifest-path src-tauri/Cargo.toml`：检查 Rust 编译。
- `npm run tauri -- build --debug`：在需要打包验证时生成调试桌面包。
- 发布和性能脚本以 `package.json` 为准，并受
  `docs/testing/validation-matrix.md` 约束；不得自行发明替代门禁。

## 编码风格与命名

使用严格 TypeScript 和 React 函数组件。TS、TSX、CSS、JSON 使用 2 空格
缩进，Rust 使用 rustfmt 默认格式。React 组件使用 `PascalCase`，钩子和
工具函数使用 `camelCase`，Rust 命令和函数使用 `snake_case`。文件系统
和安全敏感逻辑应保留在现有 Rust 归属模块中，除非已有文档批准边界变更。

## 界面反馈约定

所有面向用户的提示、通知、警告和错误都必须使用模态对话框。普通通知和
错误使用 `src/lib/appFeedback.ts` 的共享反馈模型；未保存退出等破坏性或
分支流程使用明确的多操作对话框。重复点击独立预览按钮时，应聚焦现有窗口并
通过按钮状态表达其已打开，而不是显示应用反馈。显示前始终把 Tauri 权限或
运行时错误转换成友好文案。

## 测试约定

功能开发和缺陷修复使用测试驱动开发：先编写或更新失败测试，再实现最小
改动，测试通过后再重构。新行为、缺陷修复和安全敏感变更必须有单元测试。
前端测试与源码相邻，命名为 `*.test.ts` 或 `*.test.tsx`；Rust 测试位于
`#[cfg(test)]` 模块或 `src-tauri/tests/`。根据影响范围覆盖授权、路径
归一化、Markdown 图片与资源处理、目录遍历、变更结果、外部修改和错误路径。
除非行为有意改变且归属文档说明原因，不得删除或弱化既有测试。每类变更的
最低命令集合以验证矩阵为准。

## 提交与合并请求约定

除初始导入外，仓库尚未形成稳定提交历史。提交信息使用简短祈使句，可带范围，
例如 `frontend: 改进预览状态` 或 `tauri: 加固工作区授权`。合并请求应包含
简要摘要、验证命令、
界面变更截图，以及安全、权限、导出或发布相关行为说明。

## 安全与配置提示

本地文件访问属于安全敏感能力。没有测试、安全契约更新和变更说明时，不得
扩大 Tauri 能力、资源范围、CSP 来源或路径授权。依赖版本保持固定；变更后
同时验证前端和 Rust 构建。
