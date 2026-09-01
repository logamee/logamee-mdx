# 文件与资源安全约束

本文约束 logamee-mdx（简称 mdx）的本地访问能力。

## 状态与范围

- 状态：生效
- 最近审阅：2026-08-14
- 范围：Tauri 命令、工作区/文件授权、资源预览、HTML 嵌入、二进制输入、
  写入/重命名/移动/回收站和应用数据存储。
- 标准实现：`src-tauri/src/path_auth.rs`、`commands.rs`、
  `resource_store.rs`、`document_save.rs`、`durable_write.rs`、
  `workspace_snapshot.rs`、`workspace_trash*.rs`、`html_preview_server.rs`、
  `settings.rs`、`recent_files.rs`，以及对应的 TypeScript 解码器和测试。

## 安全模型

mdx 只应访问用户通过文件/目录选择、文件关联、拖放或既有授权明确交给
应用的本地资源。前端传来的字符串是“不可信的候选路径”，不是权限凭证。
Rust 端在实际打开、读取、写入、重命名、移动、删除和提供预览资源前重新
验证路径、平台身份、工作区根和授权令牌。

## 不可突破的规则

### 路径与工作区

1. 需要作为工作区候选提交给后端、并直接访问文件系统的路径必须是绝对路径，
   经过 Rust 归一化和类型检查；拒绝空路径、未经授权的父目录逃逸、路径
   分隔符注入和不匹配的文件/目录类型。相对资源写入目录和 Excalidraw 源
   路径必须由普通路径组件组成并留在所绑定的工作区内。Markdown 图片/
   媒体引用可以包含 `..`：这是引用已显式授权的外部资源目录时生成文档
   相对路径所必需的。允许与否只看完整路径解析和规范化后的目标：即使原始
   相对路径含 `..`，只要目标最终落在当前有效的工作区根或外部资源授权根内
   就允许；规范化后越出所有有效授权根则拒绝。相对引用本身不是权限凭证。
2. 工作区操作必须绑定 `workspace_token` + 当前根目录身份。快照、搜索租约、
   资源读取和变更回执不得跨令牌或跨根目录复用。
3. 遍历跳过符号链接和不支持的条目；标准化后一旦发现越出根目录、
   类型不一致或中途遍历错误，整个快照失败，不发布部分结果。
4. 不能直接修改工作区根目录。文件树的重命名、移动和删除必须先检查目标
   父目录、同名冲突、活动文档关系和当前作用域。
5. HTML 嵌入作用域从已授权文档锚定，不能借由一个文件授权访问其预览作用域
   之外的 HTML。Markdown 图片、媒体及生成的 Excalidraw 资源通常位于当前
   工作区；只有用户另行授权外部资源目录后，才可通过规范化相对路径读取该
   当前有效授权根内的资源。绝对资源目录作为资源写入或 Excalidraw 资源同步
   目标时，必须在本次会话提供 `resource_directory_token`，并由 Rust 将令牌
   解析为对应的授权根；没有令牌时拒绝该绝对目标。读取同样必须重新标准化并
   匹配当前有效的工作区/资源授权，不得把目录字符串或 `..` 本身当作权限。

### 读取、预览与 CSP

1. 资源预览使用现有带作用域的资源命令；不得把任意绝对路径拼成
   `file://`、裸 `asset://` 或不受约束的网络 URL。
2. `src-tauri/tauri.conf.json` 的 CSP 和 `assetProtocol.scope: []` 是安全
   边界。新增 `connect-src`、`frame-src`、`img-src`、媒体源或资源作用域
   必须有威胁模型、测试和文档更新。
   已记录的 Markdown 音视频内嵌计划不授权扩大这些范围；实现必须优先复用
   现有带作用域的资源命令，并在读取前重新验证当前文档、工作区或外部资源
   授权。媒体播放使用授权的回环 HTTP 预览站点（`http://127.0.0.1:*`）和
   Range 响应，避免 Linux WebKit/GStreamer 无法读取 `asset://` 媒体；站点
   仅接受本机请求、校验 Host、授权根和媒体租约令牌。MSE 播放器（FLV/MPEG-TS）
   通过 `connect-src` 读取该站点，原生媒体元素通过 `media-src` 读取；前端拒绝
   未经预览命令签发的任意回环媒体 URL。两者都只允许应用签发的回环资源访问，
   不得将静态 CSP 的端口通配符视为对其他本机服务的授权。若确需调整这些来源、
   媒体上限或协议作用域，必须作为独立安全变更审阅和验证。
3. HTML 预览和 Markdown HTML 嵌入都必须经过现有本地预览服务器、已授权的
   文件/工作区作用域和 iframe 沙箱；它们不把原始 HTML 放进宿主 React DOM。
   独立 HTML 预览的 `HTML_PREVIEW_SANDBOX` 实际允许脚本、同源、表单、模态
   窗口、弹窗、弹窗逃逸沙箱和下载。Markdown 嵌入使用更窄的
   `MARKDOWN_HTML_EMBED_SANDBOX`，只允许脚本、同源和表单；其所有者租约在
   组件、文档或窗口变化时释放。安全边界是回环地址预览服务的授权路径、CSP、
   对应 sandbox 属性和站点数上限，而不是 DOMPurify。这两种能力都不是把恶意
   HTML 变成惰性内容的净化器；打开不受信任的 HTML 应被视为在具备上述能力
   的 iframe 中运行文档代码，不得宣传为“无脚本安全预览”。
4. 离线 HTML 导出、DOCX 预览和富文本粘贴必须使用各自现有的
   DOMPurify/白名单；外部链接、资源和可执行内容按对应策略归一化，不能
   把未验证内容写入导出 DOM 或 DOCX/粘贴结果。
5. PDF 不走 DOM 净化器：只允许现有 PDF.js 工作线程/画布渲染路径，执行
   页数、单页像素、活动画布像素、并发和超时限制；不得把 PDF HTML 化或
   将其内部 URL/脚本交给普通预览 DOM。

独立 `prepare_html_preview` 站点当前在同一文档的后续准备、授权变化或服务端
错误路径中被替换/回收，并受 `MAX_PREVIEW_SITES = 8` 限制；但当前
`WindowEvent::Destroyed` 会显式释放 Markdown 嵌入所有者，而
`RunEvent::Exit` 和窗口销毁路径都没有统一调用 `stop_all_sites()`。这是已记录的生命周期补强项：在该
补强完成前，不得把“关闭窗口立即释放独立站点”写成已实现保证。

### 大小与资源上限

当前实现中的上限是约束的一部分，修改时必须同步 Rust、TypeScript 和测试：

| 资源 | 当前上限 | 主要实现 |
|---|---:|---|
| 图片输入 | 64 MiB | `src-tauri/src/commands.rs`、`src/lib/p2BinaryPolicy.test.ts` |
| PDF 输入 | 64 MiB；最多 500 页；单页最多 32M 像素；活动画布最多 64M 像素；最多 2 个并发渲染；解析/单页超时 30s/15s | `src/lib/pdfRenderScheduler.ts`、`pdfPreviewRuntime.ts` |
| DOCX 输入 | 32 MiB；ZIP 最多 10,000 个条目、展开后最多 128 MiB，展开比最多 100 倍 | `docx_preflight.rs`、`docxWorkerConversion.ts` |
| DOCX 预览 HTML | 4 MiB；最多 50,000 个节点/图片；单图 8 MiB/24M 像素；总图 32 MiB/64M 像素 | `src/lib/docxResources.ts`、`docxSanitizer.ts` |
| 一般工作区资源 | 16 MiB | `resource_store.rs` |
| HTML 预览站点 | 8 个活动站点；独立预览与嵌入共用上限 | `src-tauri/src/html_preview_server.rs` |
| 导出载荷（Rust） | 每个载荷 64 MiB（含 Excalidraw 包成员）；HTML、PNG 还须通过格式签名校验 | `export_store.rs` |
| 导出预检 | 文档 2,000,000 字符；生成 HTML 32 MiB；单图 16 MiB；PNG 80M 像素 | `src/lib/exportPreflight.ts`、`longPngExport.ts` |
| 工作区索引遍历 | 200,000 个条目 | `workspace_snapshot.rs` |
| 活动索引操作 | 16 个 | `workspace_index_runtime.rs` |
| 设置/会话/最近文件存储 | 64 KiB（路径另有限制） | 对应 Rust 存储模块 |
| 崩溃草稿 | 单份正文 5 MiB；总量 20 MiB；最多 16 个条目；路径提示 32 KiB | `crash_drafts.rs`、`crash_draft_commands.rs` |

超过上限必须返回可识别的错误并在界面显示友好对话框；不得截断后继续
解析，也不得仅在前端限制而绕过 Rust 限制。

### 写入、版本和不确定结果

1. 文档保存使用文件版本（标准路径、平台身份、长度、修改时间和 sha256）及
   待处理覆盖令牌，检查目标没有被外部替换。
2. 写入使用持久/原子机制；目标竞争、权限失败、崩溃或 IPC 响应
   丢失都必须保留可恢复信息。
3. 工作区变更只允许三种语义：
   - `confirmed-committed`：后端已提交，并带可验证回执；
   - `confirmed-not-committed`：后端确认未提交，界面保留原快照并显示原因；
   - `indeterminate`：结果无法证明，界面不得显示成功，必须给出恢复/刷新动作。
4. 删除只有在系统回收站适配层证明放置结果后才能提交快照；“源文件暂时
   不存在”本身不是删除成功的证据。
5. 前端收到 `stale` 回执时重新读取工作区；不得直接乐观地增删一行，
   也不得让旧工作区的异步结果覆盖新工作区。

### 应用数据与权限

- 旧 `mmd-*` 事件名、`mmd.*` 存储键、`.mmd-*` CSS 类、`mmd:embed` /
  `mmd:source` 格式标记、`MMD_*` 环境变量和 `local.mmd.editor` 应用标识符
  是安全与数据兼容边界。没有经审阅的迁移设计、兼容测试和回滚方案时不得
  修改，以免切换应用数据目录、遗失设置或草稿、破坏文档及窗口协议。

- 设置、最近文件、工作区会话和崩溃草稿存放在 Tauri 应用数据目录，使用
  既有版本化/原子替换/大小限制；损坏或过大的记录应
  被清理并以可恢复方式提示，而不是执行任意内容。
- `src-tauri/capabilities/default.json` 只授予现有窗口所需的最小权限。
  新增窗口、插件、权限或系统 API 时必须说明用途、范围和回滚方式。
- 不记录文档正文、路径列表或凭证到遥测/日志；测试夹具使用临时目录
  和合成内容。

## 前端契约

- `src/lib/tauriCommands.ts` 和 `src/lib/workspaceFileKind.ts` 对 IPC 响应做
  精确键、枚举、base64、文件版本和回执解码；未知形状必须拒绝。
- `normalizeAppError`/`getFeedbackDialog` 将 Rust 技术错误映射为用户可理解
  的模态文案；不要在组件里复制字符串匹配或直接显示 `String(error)`。
- 预览 URL 由 `workspacePreviewSource.ts` 等工具函数生成并带修订号/缓存语义；
  组件不得自行拼接路径或绕过工具函数。

## 必须伴随的测试

涉及本文件任一约束的变更，至少补充或确认以下覆盖：

- Rust：路径归一化、根目录逃逸、符号链接、授权令牌、版本冲突、原子写入、
  工作区快照、索引失效、HTML 预览作用域/站点上限/租约替换、回收站不确定
  结果和资源大小。
- TypeScript：协议精确键解码、文件类型矩阵、带作用域的预览 URL、HTML
  iframe 沙箱、离线 HTML/DOCX/富文本净化器、PDF.js 资源调度、回执对账和
  友好错误映射。
- 集成/打包：若改动窗口、文件关联、启动参数、CSP、更新器或发布命令，
  运行对应 `scripts/ci` 契约测试和调试构建；详见验证矩阵。

任何无法在本地执行的安全验证都必须在交付说明中明确写出原因和替代证据。
