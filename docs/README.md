# logamee-mdx（简称 mdx）文档索引

本目录记录 mdx 的架构、行为约束和验证方式。新增或移动文档时，必须
在本页和 `.codex/rules/project-rules.md` 同步补充索引。

## 快速查找

| 你在找什么 | 去哪里 |
|---|---|
| 产品目标、视觉语言、组件、无障碍、响应式 | [`../DESIGN.md`](../DESIGN.md) |
| 已交付能力、进行中工作和未来计划 | [`../ROADMAP.md`](../ROADMAP.md) |
| 前端/后端边界、IPC、文件类型和窗口模型 | [`architecture/editor-architecture.md`](architecture/editor-architecture.md) |
| 路径授权、工作区令牌、资源、HTML 沙箱、写入和 CSP | [`constraints/security-and-file-access.md`](constraints/security-and-file-access.md) |
| 打开、编辑、保存、外部变化、恢复和导出行为 | [`specs/document-lifecycle.md`](specs/document-lifecycle.md) |
| 测试分层、命令、发布和性能证据 | [`testing/validation-matrix.md`](testing/validation-matrix.md) |
| 10k/100k 工作区索引性能基线 | [`performance-baselines.md`](performance-baselines.md) |

## 文档关系

```text
AGENTS.md                         工作入口、变更纪律、文档路由
        │
        ├── DESIGN.md             产品与 UI/UX 设计源文件
        ├── ROADMAP.md            已交付状态与未来计划
        │
        └── docs/README.md        文档索引
                ├── architecture/editor-architecture.md
                ├── constraints/security-and-file-access.md
                ├── specs/document-lifecycle.md
                ├── testing/validation-matrix.md
                └── performance-baselines.md
```

## 文档约定

- `architecture/` 说明长期稳定的模块边界、状态流和协议归属，不写某次
  临时实现的逐行教程。
- `constraints/` 只记录必须保持的安全、兼容和资源边界；每条高风险约束
  都应能在代码或测试中找到对应证据。
- `specs/` 描述用户可观察的行为和验收场景；实现发生变化时先确认
  行为是否真的要变，再改规范和测试。
- `testing/` 记录验证命令、覆盖范围和证据要求，不以“编译通过”替代
  业务行为测试。
- `performance-baselines.md` 只记录由脚本生成的性能产物和门禁语义；
  不把基线数字写成产品体验承诺。
- 文档中的“必须/不得”是约束，“当前实现”是事实，“待决”是尚未
  授权的产品选择；不要把三者混写。
