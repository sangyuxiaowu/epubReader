# EPUB 阅读器 (桌面版)

基于 **Tauri 2 + Vite + epubjs** 构建的跨平台桌面 EPUB 阅读器。

## 功能特性

- 📚 **书架管理**：以卡片网格展示所有书籍，含封面图
- 📂 **拖拽添加**：直接拖拽 `.epub` 文件到窗口即可入架
- 🖱️ **系统打开文件**：桌面版支持双击 `.epub` 文件导入，已运行时会复用当前实例
- 🗂️ **分类管理**：新建/重命名/删除分类，书籍可拖拽排序
- 🔄 **分类内排序**：书籍在分类内支持拖拽重新排列
- 💾 **持久化**：书架内容、分类顺序和阅读进度保存在 IndexedDB
- 📖 **分页阅读**：epubjs 分页渲染，键盘 ← / → 翻页
- 🔖 **书签**：任意位置添加/管理书签
- 🎨 **主题**：白色 / 米白护眼 / 暗色夜间三种主题
- 🔠 **字体**：字号大小调节 + 中文字体切换

## 技术栈

| 层次 | 技术 |
|------|------|
| 桌面容器 | Tauri 2 |
| 前端构建 | Vite 6 |
| EPUB 渲染 | epubjs 0.3 |
| 本地存储 | localforage (IndexedDB) |
| 拖拽排序 | SortableJS |

## 目录结构

```
.
├── index.html          # 书架页（入口）
├── reader.html         # 阅读器页
├── src/
│   ├── bookshelf.js    # 书架逻辑
│   ├── bookshelf.css   # 书架样式
│   ├── reader.js       # 阅读器逻辑
│   └── reader.css      # 阅读器样式
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   ├── icons/          # 应用图标（占位符，正式发布前需替换）
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── vite.config.js
```

## 快速开始

### 前置要求

- Node.js >= 18
- Rust（stable）
- 系统依赖（参考 https://v2.tauri.app/start/prerequisites/）
  - **Linux**: `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio C++ Build Tools, WebView2

### 安装与运行

```bash
# 安装依赖
cnpm install

# 开发模式（热重载）
cnpm run tauri dev

# 构建生产版本
cnpm run tauri build
```

## 桌面文件管理

- 安装包会注册 `.epub` 文件关联，并声明 `application/epub+zip` MIME 类型。
- 首次通过系统打开 `.epub` 文件时，应用会自动导入到书架；如果只打开 1 本书，会直接进入阅读页。
- 当应用已经在运行时，再次从资源管理器打开 `.epub` 文件，会复用当前实例并继续导入，不会再启动第二个窗口。