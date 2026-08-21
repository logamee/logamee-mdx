# logamee-mdx（简称 mdx）

mdx 是一个本地优先的 Markdown 桌面编辑器，使用 Tauri 2、React、TypeScript
和 Rust 构建。它把工作区文件树、编辑器、实时预览、大纲、资源预览和导出
放在同一个可恢复的桌面工作流中。

## 已交付

- 本地 Markdown/HTML/Excalidraw 编辑与 Typora/Jinxiu 风格实时预览。
- 图片、音频、视频、PDF、DOCX 和 Excalidraw 资源的受控预览。
- 工作区文件树、大纲、快速打开、全文/文件名搜索、最近文件和会话恢复。
- 文件关联、启动参数、拖放、第二实例聚焦和独立预览窗口。
- 版本感知保存、外部文件变化/保存冲突对话框、崩溃草稿恢复和系统回收站。
- 离线 HTML、高清长图 PNG 和 Excalidraw 三件套导出、主题皮肤、明暗
  外观、中文/英文界面和键盘操作。
- Rust 端路径授权、工作区令牌、资源作用域、CSP、大小限制和不确定变更处理。

## 实验性能力

- Excalidraw 场景与配对资源同步、HTML 页面嵌入和跨窗口媒体插入协议。
- 大型工作区索引的有界构建、取消、失效和性能基线。
- 打包生命周期、文件关联和跨平台冒烟测试运行器；桌面视觉验收仍需按发布矩阵
  在目标平台执行。

## 计划路线

- 继续完善文档驱动约束：`AGENTS.md`、`DESIGN.md` 和 [`docs/`](docs/README.md)。
- 在不改变本地优先边界的前提下，补充更多格式兼容性夹具和真实导出回归。
- 评估是否需要浏览器降级模式、可迁移的导出配置结构和可选协作能力；
  在产品决策落档前不改变当前安全模型。

## 开发

```bash
npm install
npm run dev
```

常用验证命令和按变更类型的最低门禁见 [`docs/testing/validation-matrix.md`](docs/testing/validation-matrix.md)。
开始任何实现前先阅读 [`AGENTS.md`](AGENTS.md) 与 [`DESIGN.md`](DESIGN.md)。

## 关注公众号

<div align="center">

<img src="https://cdn.jsdelivr.net/gh/logamee/logamee-mdx@main/assets/scan-follow.webp" width="640" alt="扫码或搜索关注逻辑帧公众号" />

</div>

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
