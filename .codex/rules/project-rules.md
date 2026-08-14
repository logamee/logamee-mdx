# logamee-mdx（简称 mdx）项目规则索引

本文件用于快速发现仓库指导规则。这里只链接事实来源，不复制完整内容到
智能体提示中。

## 始终生效的规则

- 根工作契约：[`AGENTS.md`](../../AGENTS.md)
- 产品与视觉事实来源：[`DESIGN.md`](../../DESIGN.md)
- 已交付状态与未来计划：[`ROADMAP.md`](../../ROADMAP.md)
- 文档索引：[`docs/README.md`](../../docs/README.md)
- 编辑器架构：[`docs/architecture/editor-architecture.md`](../../docs/architecture/editor-architecture.md)
- 文件系统与资源安全：[`docs/constraints/security-and-file-access.md`](../../docs/constraints/security-and-file-access.md)
- 文档生命周期规范：[`docs/specs/document-lifecycle.md`](../../docs/specs/document-lifecycle.md)
- 验证矩阵：[`docs/testing/validation-matrix.md`](../../docs/testing/validation-matrix.md)
- 性能基线契约：[`docs/performance-baselines.md`](../../docs/performance-baselines.md)

## 变更路由

| 变更范围 | 修改前必读 | 必须提供的配套证据 |
|---|---|---|
| 编辑器布局、主题、对话框、无障碍 | `DESIGN.md` | 聚焦组件测试；修改 JSX/CSS 时运行 `npm run lint` |
| 打开、保存、重命名、移动、删除、会话恢复 | `docs/specs/document-lifecycle.md` | 前端生命周期测试和 Rust 命令/安全测试 |
| Tauri 命令、路径、资源、CSP、HTML iframe 沙箱、二进制处理 | `docs/constraints/security-and-file-access.md` | Rust 测试及 TypeScript 协议解码/预览策略测试 |
| Markdown、HTML、Excalidraw、媒体、PDF、DOCX、导出 | `docs/architecture/editor-architecture.md` 和生命周期规范 | 对应格式的回归测试 |
| 发布、打包、性能、更新器 | `docs/testing/validation-matrix.md` | 对应脚本门禁和构建证据 |
| 新产品或设计决策 | `DESIGN.md` 和 `docs/README.md` | 新增或更新归属规范及待决问题 |

## 不可突破的不变量

- 文件系统访问由 Rust 后端授权；前端绝不能把路径字符串当作授权凭证。
- 工作区快照和变更回执必须绑定工作区令牌，并在界面报告已提交变更前完成
  对账。
- 写入必须使用现有版本检查、冲突处理和持久写入契约；不确定结果必须显示为
  待恢复事项，而不是成功。
- 预览与资源端点必须处于有效授权范围内，并遵守 Tauri CSP 和二进制大小限制。
- 所有应用级反馈都使用本地化模态对话框；后端技术错误必须先归一化再显示。
- 新界面必须使用标准主题令牌和现有 Lucide 图标约定，不得创建平行的设计
  令牌系统。
- 行为变更只有在聚焦测试和最小适用验证门禁均已运行并审阅后才算完成。

## 维护规则

新增、移动或废弃项目指导时，必须在同一变更中更新本索引和
`docs/README.md`。索引条目保持简短并链接事实来源。某条规则若演变成重复
出现的实现模式，应移动到归属的架构、约束、设计或测试文档，而不是无限扩张
本索引。
