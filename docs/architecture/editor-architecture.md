# 编辑器架构与边界

本文描述 logamee-mdx（简称 mdx）的实现边界。

## 状态

- 状态：生效
- 最近审阅：2026-08-14
- 范围：mdx 前端、Tauri IPC、工作区生命周期和文件类型呈现。
- 实现证据：`src/App.tsx`、`src/types.ts`、`src/lib/tauriCommands.ts`、
  `src/lib/documentSession.ts`、`src/lib/workspaceFileKind.ts`、
  `src/lib/htmlPreviewPolicy.ts`、`src-tauri/src/lib.rs`、
  `src-tauri/src/commands.rs`、`src-tauri/src/html_preview_server.rs`、
  `src-tauri/src/state.rs`。

## 总体分层

```text
用户输入 / 原生菜单 / 文件关联 / 拖放 / 第二实例
                         │
                         ▼
React 应用 + 钩子 + 组件
  ├─ 文档/工作区/会话编排
  ├─ 协议解码与过期结果防护
  ├─ 编辑器 + Markdown 预览 + 对话框
  └─ 独立窗口/事件同步
                         │  类型化调用 / 事件
                         ▼
Tauri 命令 + AppState
  ├─ 路径授权与工作区令牌
  ├─ 文档持久写入与版本检查
  ├─ 快照、索引、最近文件、设置、崩溃草稿
  ├─ 资源与 HTML 预览服务
  └─ 原生菜单、文件监视器、回收站与窗口生命周期
                         │
                         ▼
本地文件系统 / 应用数据目录 / 操作系统窗口与回收站
```

前端负责展示、用户意图编排和协议解码；Rust 负责实际文件访问、授权、
写入、目录遍历、系统集成和持久化。展示组件不得自行拼接绝对路径或直接
调用未经解码的 IPC 返回值。

## 兼容标识

正式项目名已改为 `logamee-mdx`，产品显示名和 GUI 主程序名为
`mdx`。既有 `mmd-*` 事件名、`mmd.*` 存储键、`.mmd-*` CSS 类、
`mmd:embed` / `mmd:source` 格式标记、Excalidraw 场景来源值、崩溃草稿
完整性域、工作区索引实现/结构标识、`MMD_*` 环境变量以及
`local.mmd.editor` 应用标识符仍是跨版本兼容契约。历史 Rust 库名
`mmd_lib` 和辅助基准程序 `mmd_bench` 是保留的内部构建标识，不是产品
显示名。这些标识可能关联已保存设置、窗口通信、文档内容、草稿验证、
自动化脚本和操作系统应用数据目录；除非迁移设计明确规定双读/双写、版本
检测、回滚和回归测试，否则不得重命名或删除。

## 模块所有权

| 责任 | 主归属 | 约束 |
|---|---|---|
| 应用编排、当前文档和弹窗协调 | `src/App.tsx`、`src/hooks/` | 处理世代编号/身份过期结果；不绕过领域工具函数 |
| 文件树、大纲和工作区交互 | `FileSidebar`、`FileTreeRows`、`src/lib/fileTree*` | 仅使用工作区快照和变更回执更新视图 |
| 编辑表面 | `EditorPane`、CodeMirror 工具函数 | 文本编辑不直接承担保存授权或文件系统访问 |
| Markdown 渲染 | `JinxiuMarkdown`、`src/lib/markdown*`、`markdown/` | 预处理只在代码围栏外生效；渲染策略要有格式测试 |
| 其他预览 | `Workspace*Preview`、`PdfPreview`、`DocxPreview`、`ExcalidrawPane` | 重模块懒加载；资源读取必须有授权和大小边界 |
| 反馈和分支决策 | `src/lib/appFeedback.ts` 与各对话框 | 应用级反馈使用模态对话框；不把错误当作普通状态标签 |
| IPC 适配 | `src/lib/tauriCommands.ts`、`src/lib/workspaceFileKind.ts` | 严格解码字段、枚举和文件版本；拒绝未知形状 |
| Tauri 命令与状态 | `src-tauri/src/commands.rs`、`state.rs`、各领域模块 | 不把路径授权逻辑复制到前端或多个命令中 |
| 授权和文件系统 | `path_auth.rs`、`resource_store.rs`、`workspace_snapshot.rs` | 详见安全约束，任何改动都要有 Rust 回归测试 |

## 文件类型与呈现矩阵

`WorkspaceFileKind` 是跨前后端的协议枚举。新增类型必须同时更新 Rust
分类、`src/types.ts`、协议解码、呈现映射、菜单/文件树图标、预览或编辑
入口以及对应测试。

| 类型枚举值 | 内容模式 | 界面表面 | 写入能力 |
|---|---|---|---|
| `markdown` | `text` | CodeMirror + Jinxiu/Typora 风格预览 | 编辑、保存、资源写入 |
| `html` | `text` | HTML 编辑 + 本地服务/iframe 沙箱预览；独立预览允许脚本、同源、表单、模态窗口、弹窗、弹窗逃逸沙箱和下载，不走 DOM 净化器 | 按现有 HTML 预览契约保存 |
| `excalidraw` | `text` | Excalidraw 画布 | 场景与配对资源同步 |
| `image` | `binary` | 工作区图片预览 | 只读预览 |
| `video` / `audio` | `binary` | 媒体预览 | 只读预览 |
| `pdf` | `binary` | PDF.js 预览 | 只读预览 |
| `docx` | `binary` | Mammoth 工作线程/文档预览 | 只读预览 |

二进制文档通过受限 base64/资源协议传输；不要把大文件转换成前端无限
增长的字符串，也不要为了统一界面而伪造编辑能力。

## 文档和工作区状态

### 当前文档

前端文档状态包含 `documentId`、`documentEpoch`、当前路径、文件类型、
内容、上次保存内容、文件版本和预览修订号。打开流程可以短暂进入
`provisional`，只有后端提交回执确认后才变为 `committed`；失败、取消或
未知结果必须恢复旧状态或显式进入恢复分支。所有异步结果都要检查当前
文档身份和世代编号，不能让旧请求覆盖新文档。

### 工作区

工作区由绝对根目录、短期 `workspace_token`、文件/目录快照和可丢弃的
搜索索引组成。文件树、搜索、创建、重命名、移动和删除都以令牌 + 根目录
为身份；快照回执为 `fresh`、`stale` 或 `not-applicable`。收到 `stale` 时
重新扫描，不能把旧列表拼接成“看似最新”的结果。

### 窗口与事件

主窗口拥有工作区和当前编辑状态；预览/HTML 等独立窗口通过带实例 ID 的
事件协议同步。事件投递允许短暂重试，但必须可取消并检查当前实例。任意
窗口收到 `WindowEvent::Destroyed` 时会移除该窗口的最近文件所有者，并释放其
Markdown HTML 嵌入所有者；主窗口销毁时还会停止文件监视器。工作区索引
只在 `RunEvent::Exit` 阶段统一丢弃。独立 `prepare_html_preview` 站点当前不会在
窗口销毁或应用退出时统一调用 `stop_all_sites()`，只会在后续替换、授权失败
或服务端恢复路径中回收，详见安全约束中的生命周期补强项。

## 打开与变更的边界

- 打开来源包括文件对话框、命令行/文件关联、拖放、最近文件、会话恢复
  和第二实例。它们先进入 `OpenIntentCoordinator`，再经过准备/提交
  以及身份检查，不得各自实现一套“直接打开”。
- 文档保存经过版本检查和持久写入；冲突、权限失败和 IPC 丢失按
  `DocumentSaveResponse`/`MutationOutcome` 处理，而不是只看 Promise 是否
  正常返回。
- 外部文件监视器只发出重新检查/对话框所需的事实；是否替换未保存
  内容由用户在明确的分支对话框中决定。
- 文件树删除使用系统回收站适配层；只有拿到可证明的结果才更新快照，
  不得因为源文件暂时不存在就假定删除成功。

## 懒加载与资源边界

- PDF、DOCX、Excalidraw 预览保持动态导入，并通过 `LazyPreviewBoundary`
  提供稳定加载和失败回退。
- Markdown 正文音视频内嵌属于未来计划，当前实现只有音视频文件的独立只读
  预览和音频普通链接插入。后续实现应归属现有 Markdown 渲染管线，复用带
  作用域的资源命令、当前文档身份和预览修订号，不得由渲染组件直接读取任意
  路径或建立第二套媒体授权协议。
- Markdown 图片、媒体和 Excalidraw 配对资源走授权资源命令，不直接暴露任意
  `file://` URL；HTML 文件和 Markdown HTML 嵌入走本地预览服务、授权作用域
  与 iframe 沙箱。Markdown 嵌入的沙箱只允许脚本、同源和表单；独立 HTML
  预览另允许模态窗口、弹窗、弹窗逃逸沙箱和下载。两者都不是 HTML 净化器。
- 导出当前实现为离线 HTML、长图 PNG 和 Excalidraw 三件套。前端生成内容、
  预检资源，再交给 Rust 对话框和持久写入流程保存；PDF 目前是只读预览，
  不是导出格式。导出失败不得改变当前文档的已保存状态。

## 变更规则

1. 新增跨层行为时先更新本文件的边界/矩阵和生命周期规范，再实现。
2. 修改 IPC 字段时同时更新 Rust 模型、TypeScript 解码器、调用方和契约
   测试；未知字段/枚举不应被静默接受。
3. 修改文件类型、资源权限、窗口事件或保存流程时必须阅读并遵守
   `docs/constraints/security-and-file-access.md`。
4. 任何界面结构变化必须符合 `DESIGN.md` 的组件归属、令牌、无障碍和
   响应式约束。
