# timeline-desktop

一个面向 Windows 的本地个人活动时间线工具。项目包含 Rust 本地常驻服务、React + Vite 前端，以及 Chrome/Edge Manifest V3 浏览器扩展。所有数据默认保存在本地 SQLite，HTTP API 仅限 loopback 访问。

文档、注释和 UI 文案以中文为主。

---

## 项目结构

```text
timeline-desktop/
├── Cargo.toml                 # Workspace 根配置
├── apps/
│   ├── timeline-backend/      # Rust 后端（包名 timeline，可执行文件 timeline.exe）
│   ├── web-ui/                # React + Vite 前端
│   └── browser-extension/     # Manifest V3 浏览器扩展
├── crates/
│   └── common/                # 后端、前端、扩展共享的数据结构（serde 类型）
├── docs/
│   ├── architecture.md        # 架构与数据流说明
│   ├── api.md                 # 本地 HTTP API 文档
│   ├── schema.md              # SQLite 表结构说明
│   └── frontend-guidelines.md # 前端骨架与交互规范（必读）
├── scripts/
│   └── build-installer.ps1    # 构建面向用户的 Windows 安装包
├── installer/
│   └── timeline.iss           # Inno Setup 安装包脚本
├── config/
│   └── timeline.example.toml  # 配置示例
└── .github/workflows/
    └── package-windows.yml    # GitHub Actions 打包工作流
```

---

## 技术栈

- **后端:** Rust (edition 2024)，Tokio 异步运行时，Axum Web 框架，SQLx + SQLite，tao + tray-icon（系统托盘），windows/winreg/winrt-notification 等 Windows 原生 API。
- **前端:** React 19，Vite 8，TypeScript ~5.9，ECharts 6，react-calendar-timeline，dayjs，interactjs。
- **扩展:** 原生 JavaScript，Chrome Extension Manifest V3（service worker + content script）。
- **构建脚本:** PowerShell（`*.ps1`），仅支持 Windows。

---

## 开发运行命令

### 启动后端

```powershell
cargo run -p timeline
```

显式指定配置：

```powershell
cargo run -p timeline -- --config config/timeline.toml
```

默认监听地址：`127.0.0.1:46215`。

### 启动前端（开发模式）

```powershell
cd apps/web-ui
npm install
npm run dev
```

开发服务器端口为 `4173`。前端默认调用 `http://127.0.0.1:46215`。如需改地址，可设置环境变量 `VITE_API_BASE_URL`。

前端可用命令：
- `npm run dev` — 开发服务器
- `npm run build` — 生产构建（输出到 `apps/web-ui/dist`）
- `npm run lint` — ESLint 检查
- `npm run preview` — 预览生产构建

### 加载浏览器扩展

1. 打开 `edge://extensions` 或 `chrome://extensions`
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 指向 `apps/browser-extension`

### 后端测试

```powershell
cargo test -p timeline
cargo test -p common
```

现有测试主要分布在 `apps/timeline-backend/src/config.rs` 和 `http.rs` 中。

---

## 架构概览

### 可执行文件模式

`timeline.exe` 直接启动采集服务、HTTP API 和系统托盘。

内置在线升级机制已移除；版本更新通过重新安装新版本安装包完成，安装包升级不会覆盖用户的 `config/` 与 `data/`。

### 核心数据流

1. **Focus Tracker:** 每秒轮询 Windows 前台窗口（`GetForegroundWindow`），窗口指纹变化时结束旧 `focus_segment` 并创建新段。
2. **Presence Tracker:** 每秒检测用户输入 idle 时长与工作站锁定状态，生成 `presence_segment`（状态：`active` / `idle` / `locked`）。
3. **Browser Bridge:** 扩展仅在“当前聚焦的浏览器窗口”有活动标签页时，向 `/api/events/browser` 上报域名事件；后端仅在确认前台为浏览器时维护 `browser_segment`。
4. **Web UI:** 通过日期查询 `focus_segments`、`browser_segments`、`presence_segments`，并渲染时间线与统计图表。

### 关键源码文件

- `apps/timeline-backend/src/main.rs` — 后端服务入口与启动流程
- `apps/timeline-backend/src/config.rs` — TOML 配置加载、默认值、路径解析
- `apps/timeline-backend/src/trackers.rs` — focus / presence 轮询与浏览器事件合并逻辑
- `apps/timeline-backend/src/state.rs` — 全局运行时状态（Arc 包裹）
- `apps/timeline-backend/src/db.rs` — SQLite 连接、迁移、读写模型
- `apps/timeline-backend/src/http.rs` — Axum 路由与 CORS/Origin 校验
- `apps/timeline-backend/src/windows.rs` — Win32 API 封装（前台窗口、idle 检测）
- `apps/timeline-backend/src/system.rs` — 托盘、自启动注册表、toast 通知
- `crates/common/src/lib.rs` — 共享 API 类型（ envelope、segment、settings 等）
- `apps/browser-extension/service-worker.js` — 扩展核心逻辑（标签页缓存、心跳、上报）
- `apps/browser-extension/content-script.js` — 在 loopback 页面向扩展通知 agent origin

---

## API 约定

所有接口返回统一信封格式：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

时间字段统一使用 RFC 3339 UTC 字符串。

CORS 限制：浏览器请求 Origin 必须是 loopback（`127.0.0.1`、`localhost`、`::1`）。浏览器扩展需带上自定义请求头 `X-Timeline-Extension: browser-bridge`。

主要端点：
- `GET /health`
- `GET /api/timeline/day?date=YYYY-MM-DD`
- `GET /api/stats/apps?date=YYYY-MM-DD`
- `GET /api/stats/domains?date=YYYY-MM-DD`
- `GET /api/stats/focus?date=YYYY-MM-DD`
- `GET /api/settings`
- `POST /api/settings/config`
- `POST /api/settings/autostart`
- `POST /api/events/browser`

详见 `docs/api.md`。

---

## 前端开发规范

前端骨架与交互有严格约束，见 `docs/frontend-guidelines.md`。核心原则：

- **同构骨架（Structural Skeleton）:** `loading` 与 `loaded` 必须共享同一套 DOM 结构与网格轨道；禁止整棵树替换式骨架。
- **刷新不回退骨架:** 已有历史数据时刷新，默认保留旧数据展示，不回退 skeleton。
- **交互稳定优先:** hover/selected 不得互相抢焦点；图表容器内边距在父层统一处理。

每次改动后必须执行 `npm run build` + `npm run lint` 并通过手工刷新场景回归。

---

## 数据库与迁移

后端使用 SQLx + SQLite，表结构在 `db.rs` 的 `MIGRATIONS` 常量中定义。当前包含 3 个版本迁移：

1. `create_core_tables` — 创建 `app_registry`、`focus_segments`、`browser_segments`、`presence_segments`、`raw_events`
2. `create_indexes` — 为常用查询字段加索引
3. `add_last_seen_columns` — 增加 `last_seen_at` 列用于安全收尾

启动时会自动运行 `restore_unclosed_segments()`，将上次异常退出未关闭的 segment 按最后一次真实观测时间收尾。

`raw_events` 表 capped 在 50,000 行以内，仅用于本地调试。

---

## 安全与隐私边界

- 默认只记录应用名、进程信息、窗口标题、域名和活跃状态。
- 默认不记录页面正文、输入内容、剪贴板和截图。
- 数据只保存在本地 SQLite。
- HTTP API 默认仅接受 loopback 来源请求。
- 配置项 `record_window_titles` 与 `record_page_titles` 可分别关闭窗口标题和页面标题记录。

---

## 打包与发布

### 本地构建安装包

前置条件：已安装 Node.js / npm 和 Rust toolchain。

安装包构建还需要安装 Inno Setup 6/7，并确保 `ISCC.exe` 在 PATH 中，或通过 `-InnoSetupCompiler` 显式指定。

```powershell
.\scripts\build-installer.ps1
```

输出位置：`target/installer/output/timeline-setup.exe`

该脚本会构建 `apps/web-ui/dist`、编译 `timeline.exe`、组装安装源目录，再调用 Inno Setup 打包。安装包是普通用户主入口。

### GitHub Actions

`.github/workflows/package-windows.yml`：
- 在 Release `published` 时自动触发
- 支持手动 `workflow_dispatch` 触发
- 安装 Inno Setup 并调用 `build-installer.ps1`
- 将 `.exe` 安装包和 `SHA256SUMS.txt` 上传到 Release assets

---

## 配置说明

示例配置位于 `config/timeline.example.toml`。主要字段：

- `database_path` — SQLite 文件路径
- `lockfile_path` — 单实例锁文件路径
- `listen_addr` — 本地 HTTP 服务监听地址（默认 `127.0.0.1:46215`）
- `web_ui_url` — 托盘与设置页里展示的 Web UI 地址
- `idle_threshold_secs` — 判定 idle 的阈值（秒，默认 300，范围 15~1800）
- `poll_interval_millis` — 轮询间隔（毫秒，默认 1000，范围 250~5000）
- `health_reminder_enabled` — 是否启用连续活跃休息提醒
- `health_reminder_threshold_secs` — 健康提醒触发阈值（秒，默认 3000，范围 300~21600）
- `tray_enabled` — 是否启用系统托盘
- `record_window_titles` / `record_page_titles` — 是否记录窗口/页面标题
- `ignored_apps` / `ignored_domains` — 忽略列表

配置文件内的相对路径按“配置文件所在目录”解析。

---

## 代码风格与提交前检查

- Rust：使用 edition 2024，`cargo fmt` 与 `cargo clippy` 建议保持干净。
- 前端：`npm run lint` 必须通过；`npm run build` 必须成功；遵循 `docs/frontend-guidelines.md` 中的骨架与交互规范。
