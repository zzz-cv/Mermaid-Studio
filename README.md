# Mermaid Studio

一款轻量级 Mermaid 图表编辑工具，支持 Markdown 文件管理、Mermaid 代码编辑、实时预览以及图表导出。

Mermaid Studio 致力于提供一个简单、高效的本地化 Mermaid 开发环境，让用户无需依赖在线编辑器，即可在桌面端完成 Mermaid 图表的编写、预览和管理。

(Mermaid Studio完全基于ai编程开发，可能会有或大或小的bug)

---

## 为什么开发 Mermaid Studio

在日常开发中经常需要画时序图、状态图、流程图等，我使用了目前开源的一些网页或插件，发现有如下一些痛点：

- VsCode等自带的插件: 不美观，并且没有不同类型图的选择等便捷功能，操作复杂
- Mermaid官方等网页版工具: 开发中有保存Mermaid代码的需求，网页只能保留最近一次的更改；同时一些网站需要收费
- Github的一些开源项目: 项目功能不完善或者没有想要的功能

为解决这些痛点，更符合自己的开发编写习惯，我设计了这款软件，但由于本人只接触过Java后端开发等工作，因此只好用ai快速搓出来一版，后续可能会更新加入新类型的图表

---

## 功能特性

### Mermaid 编辑

- 支持 Mermaid Markdown 语法编辑
- 支持实时渲染预览
- 编辑内容与预览窗口同步更新

### 文件管理

- 支持本地 Markdown 文件管理
- 支持打开、编辑 Mermaid 文件
- 方便管理个人图表项目

### 图表预览

支持 Mermaid 常用图表类型：

- Flowchart（流程图）
- Sequence Diagram（时序图）
- State Diagram（状态图）
- Class Diagram（类图）
- ER Diagram（实体关系图）
- Gantt Chart（甘特图）
- Mindmap（思维导图）

### 导出功能

支持将 Mermaid 图表导出为：

- SVG
- PNG
- Markdown

### 桌面应用

- Windows 桌面端运行
- 无需浏览器环境
- 支持独立安装与免安装运行

---

## License

本项目采用 MIT License。