# timeline

一个面向 Windows 的本地活动时间线工具。它在本机记录应用前台状态、浏览器活跃域名与 idle/locked 状态，并把数据写入本地 SQLite，由本地 Web UI 展示为时间线与统计结果。

## 目标

- 只采集本机与浏览器活动，不接触敏感隐私数据（不读输入内容、不读剪贴板、不抓截图）
- 全部数据默认保存在本机
- 仅允许回环地址请求后端 API
- 通过安装包分发，不依赖在线升级

## 项目结构

- `apps/timeline-backend`：Rust 后端服务（`timeline.exe`）
- `apps/web-ui`：React + Vite 前端页面
- `apps/browser-extension`：Chrome/Edge Manifest V3 扩展（MV3）
- `crates/common`：后端与前端共享数据结构
- `config`：示例配置
- `scripts/build-installer.ps1`：Windows 安装包构建脚本
- `installer/timeline.iss`：Inno Setup 打包脚本
- `docs/`：架构、API、数据库与前端规范文档

## 核心能力

- 采集前台应用（应用名、进程名、可选窗口标题）
- 记录 `active / idle / locked` 状态
- 接收扩展上报的当前浏览器标签页域名
- 本地 SQLite 持久化（`focus_segments`、`browser_segments`、`presence_segments`）
- 聚合统计接口（应用/域名/专注）
- 本地 Web UI 时间线与报表
- 系统托盘与开机自启动开关
- 连续活跃提醒（可配置）
- 配置驱动的忽略列表（应用名、域名）

## 安装方式（推荐）

发布包只有一种：Windows 安装程序。

1. 在 GitHub Releases 下载 `timeline-setup.exe`
2. 双击安装，默认安装到当前用户环境
3. 运行开始菜单中的 Timeline

安装器策略：

- 不要求管理员权限（按需调用系统弹窗）
- 首次安装会写入默认 `config/timeline.toml`
- 后续版本安装不会覆盖已有 `config/` 与 `data/`
- 卸载默认保留 `config/` 与 `data/`

项目已经去掉在线升级流程；更新请下载新安装包并重新安装。

## 开发环境运行

### 1）后端（Rust）

```powershell
cargo run -p timeline
```

显式指定配置文件：

```powershell
cargo run -p timeline -- --config config/timeline.toml
```

默认监听：`127.0.0.1:46215`。  
若配置位于 `config/`，请按“配置文件所在目录”理解相对路径。

### 2）前端（Node）

```powershell
cd apps/web-ui
npm install
npm run dev
```

开发服务器会请求 `http://127.0.0.1:46215`。  
可用环境变量覆写：`VITE_API_BASE_URL`

### 3）浏览器扩展

1. 访问 `edge://extensions` 或 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `apps/browser-extension`

## 配置

示例文件：`config/timeline.example.toml`

主要字段（示例）：

- `database_path`：SQLite 路径
- `lockfile_path`：单实例锁文件路径
- `listen_addr`：HTTP 监听地址
- `web_ui_url`：托盘打开 UI 的地址
- `idle_threshold_secs`：多久无输入认为 idle
- `poll_interval_millis`：后台轮询间隔
- `health_reminder_enabled`：是否开启连续活跃提醒
- `health_reminder_threshold_secs`：提醒触发阈值
- `tray_enabled`：是否启用托盘
- `record_window_titles`：是否记录窗口标题
- `record_page_titles`：是否记录页面标题
- `ignored_apps`：忽略应用名列表
- `ignored_domains`：忽略域名列表

## 打包安装包

前置条件：

- Node.js / npm
- Rust toolchain（`cargo`）
- Inno Setup 6/7，并确保 `ISCC.exe` 可访问（PATH 或参数显式传入）

```powershell
.\scripts\build-installer.ps1
```

输出位置：`target\installer\output\timeline-setup.exe`

脚本会自动完成：

1. 编译 `apps/web-ui` 产物到 `apps/web-ui/dist`
2. 编译 `timeline.exe`
3. 组装安装文件
4. 调用 Inno Setup 生成 `.exe` 安装包

## API 入口（本地）

所有接口返回统一信封：

- `GET /health`
- `GET /api/timeline/day?date=YYYY-MM-DD`
- `GET /api/stats/apps?date=YYYY-MM-DD`
- `GET /api/stats/domains?date=YYYY-MM-DD`
- `GET /api/stats/focus?date=YYYY-MM-DD`
- `GET /api/settings`
- `POST /api/settings/config`
- `POST /api/settings/autostart`
- `POST /api/events/browser`（扩展上报）

## 常见问题

- `StartMenuExperienceHost.exe` 出现：这是 Windows 开始菜单宿主进程，不是本项目组件。
- 看到“跨重启的 active 长段”：通常是历史异常收尾导致；最近实现会按最后一次真实观测时间补齐未关闭 segment，避免把关机空档误连。
- 没有看到浏览器记录：确认浏览器扩展已加载、页面在该扩展允许上报路径下，并且后端有收到 `/api/events/browser` 请求。

## 目录一览

```text
timeline/
├─ apps/
│  ├─ browser-extension/
│  ├─ timeline-backend/
│  └─ web-ui/
├─ crates/
├─ config/
├─ docs/
├─ installer/
├─ scripts/
└─ .github/
```
