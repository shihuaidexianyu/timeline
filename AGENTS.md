# timeline

一个面向 Windows 的本地个人活动时间线工具。项目包含 Rust 本地常驻服务、React + Vite 前端，以及 Chrome/Edge Manifest V3 浏览器扩展。所有数据默认保存在本地 SQLite，HTTP API 仅限 loopback 访问。

文档、注释和 UI 文案以中文为主。

---

## 项目概述

`timeline` 在 Windows 本地记录：

- 前台应用（进程名、应用显示名、可执行路径、可选窗口标题）
- 当前输入桌面中实际露出的可见窗口（用于统计页应用趋势/应用分布默认口径）
- 浏览器前台标签页的域名（通过浏览器扩展上报）
- 设备使用状态：`active` / `idle` / `locked`

数据写入本地 SQLite，由本地 Web UI 渲染为每日时间线、应用/域名分布、专注统计、使用热度日历和设置页。

`timeline.exe` 直接启动采集服务、HTTP API 和系统托盘。内置在线升级机制已移除；版本更新通过重新安装新版本安装包完成，安装包升级不会覆盖用户的 `config/` 与 `data/`。

---

## 项目结构

```text
timeline/
├── Cargo.toml                 # Workspace 根配置
├── .cargo/config.toml         # Windows 静态 CRT 链接配置
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
└── assets/                    # 项目级资源
```

---

## 技术栈

- **后端:** Rust (edition 2024)，Tokio 异步运行时，Axum Web 框架，SQLx + SQLite，tao + tray-icon（系统托盘），windows/winreg/winrt-notification 等 Windows 原生 API。
- **前端:** React 19，Vite 8，TypeScript ~5.9，ECharts 6，react-calendar-timeline，dayjs，interactjs，TanStack Query。
- **扩展:** 原生 JavaScript，Chrome Extension Manifest V3（service worker + content script）。
- **构建脚本:** PowerShell（`*.ps1`），仅支持 Windows。
- **测试:** 后端 `cargo test`；前端 Vitest + jsdom + Testing Library 做单元测试，Playwright 做 E2E 测试。

---

## 构建与运行命令

### 启动后端

```powershell
cargo run -p timeline
```

显式指定配置：

```powershell
cargo run -p timeline -- --config config/timeline.toml
```

默认监听地址：`127.0.0.1:46215`。

调试休息提醒弹窗：

```powershell
cargo run -p timeline -- --debug-trigger-health-reminder 3000
```

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
- `npm run test` — 运行 Vitest 单元测试
- `npm run test:watch` — 监听模式运行单元测试
- `npm run test:e2e` — 运行 Playwright E2E 测试
- `npm run check` — 依次执行 lint + test + build

### 加载浏览器扩展

1. 打开 `edge://extensions` 或 `chrome://extensions`
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 指向 `apps/browser-extension`

---

## 代码组织

### 后端 (`apps/timeline-backend/src/`)

- `main.rs` — 服务入口：解析参数、加载配置、获取单实例锁、初始化 SQLite、启动 tracker、托盘、HTTP 服务。
- `config.rs` — TOML 配置加载、默认值、路径解析、运行时根目录发现、web-ui dist 目录搜索。
- `trackers.rs` — focus / visible window / presence 轮询，以及浏览器事件合并逻辑。
- `state.rs` — 全局运行时状态（`AgentState`，Arc 包裹），包含当前 focus/browser/presence/visible window segment、健康提醒状态、监视器心跳。
- `db.rs` — SQLite 连接、迁移、读写模型、统计聚合、月历/周期汇总。
- `http.rs` — Axum 路由、CORS/Origin 校验、统一 API 信封、设置接口、浏览器事件接收。
- `windows.rs` — Win32 API 封装：前台窗口、可见窗口、idle 时长、工作站锁定检测。
- `system.rs` — 系统托盘、开机自启动注册表、toast 通知、打开前端 URL。

### 共享类型 (`crates/common/src/lib.rs`)

定义后端、前端、扩展共享的 API 协议类型：

- `ApiResponse<T>` / `ApiErrorBody` — 统一 API 信封
- `PresenceState` / `AppInfo` / `FocusSegment` / `BrowserSegment` / `PresenceSegment`
- `TimelineDayResponse` / `DurationStat` / `FocusStats`
- `AgentSettingsResponse` / `UpdateAgentConfigRequest` / `UpdateAutostartRequest`
- `BrowserEventPayload` / `BrowserEventAck`
- `DaySummary` / `MonthCalendarResponse` / `PeriodSummaryResponse` / `UsageMetric`

### 前端 (`apps/web-ui/src/`)

- `app/` — 应用级壳、路由、全局状态、主题
- `shared/api/` — API 客户端、React Query hooks、TypeScript 类型
- `shared/ui/` — 通用 UI 组件（Button、Panel、Switch、SkeletonBlock 等）
- `pages/` — stats-page、timeline-page、settings-page
- `components/` — timeline-chart、donut-chart、calendar-grid 等
- `features/` — 按领域拆分的选择器与表单逻辑
- `lib/` — 图表模型、仪表盘辅助函数、主题
- `hooks/` — use-theme 等自定义 hook

### 浏览器扩展 (`apps/browser-extension/`)

- `manifest.json` — Manifest V3，版本 `1.0.2`
- `service-worker.js` — 扩展核心：标签页缓存、窗口焦点跟踪、心跳、域名事件上报
- `content-script.js` — 在 loopback 页面向扩展通知 agent origin

---

## 核心数据流

1. **Focus Tracker:** 每秒轮询 Windows 前台窗口（`GetForegroundWindow`），窗口指纹（`hwnd + process_id`）变化时结束旧 `focus_segment` 并创建新段。窗口标题不参与指纹计算，避免 IDE 切文件、浏览器切标签等标题变化将连续焦点误切成碎片段。标题仍作为段元数据记录。
2. **Presence Tracker:** 每秒检测用户输入 idle 时长与工作站锁定状态，生成 `presence_segment`（状态：`active` / `idle` / `locked`）。`locked` 优先级高于 `idle`。
3. **Visible Window Tracker:** 每秒枚举当前输入桌面的顶层窗口，排除最小化、不可见、DWM cloaked、工具窗口、空矩形窗口和忽略应用，按 z-order 扣除遮挡面积；可见面积比例大于 5% 的窗口写入 `visible_window_segments`，并增量维护 `daily_visible_app_usage`。锁屏或 idle 时关闭当前可见窗口段，用户回到 active 后重新开始计时。这保证可见窗口总时长 ≤ 活跃总时长，语义自洽。
4. **Browser Bridge:** 扩展仅在“当前聚焦的浏览器窗口”有活动标签页时，向 `/api/events/browser` 上报域名事件；后端仅在确认前台为浏览器时维护 `browser_segment`。相同 `domain + browser_window_id + tab_id` 连续事件会合并。
5. **Web UI:** 通过日期查询 `focus_segments`、`browser_segments`、`presence_segments` 和应用预聚合数据，并渲染时间线与统计图表。统计页应用趋势/应用分布默认使用可见窗口口径，可切换到前台焦点口径。

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

CORS 限制：浏览器请求 Origin 必须是后端自身地址（由 `listen_addr` 派生）或 Vite 开发服务器端口（`4173`/`5173`）。不再允许任意 loopback Origin，防止其他本地 Web 应用读取数据。浏览器扩展需带上自定义请求头 `X-Timeline-Extension: browser-bridge`。`chrome-extension://` 来源仅在带有该请求头时被允许。

主要端点：

- `GET /health`
- `GET /api/timeline/day?date=YYYY-MM-DD`
- `GET /api/stats/apps?date=YYYY-MM-DD&metric=visible_window|focus`
- `GET /api/stats/apps/trend?date=YYYY-MM-DD&period=week|month&metric=visible_window|focus`
- `GET /api/stats/domains?date=YYYY-MM-DD`
- `GET /api/stats/domains/trend?date=YYYY-MM-DD&period=week|month`
- `GET /api/stats/focus?date=YYYY-MM-DD`
- `GET /api/stats/summary?date=YYYY-MM-DD`
- `GET /api/calendar/month?month=YYYY-MM`
- `GET /api/export?date=YYYY-MM-DD&format=csv|json`
- `GET /api/debug/recent-events`（需 `debug_events_enabled = true`，默认关闭）
- `GET /api/settings`
- `POST /api/settings/config`
- `POST /api/settings/autostart`
- `POST /api/events/browser`

详见 `docs/api.md`。

---

## 数据库与迁移

后端使用 SQLx + SQLite，表结构在 `db.rs` 的 `MIGRATIONS` 常量中定义。当前包含 7 个版本迁移：

1. `create_core_tables` — 创建 `app_registry`、`focus_segments`、`browser_segments`、`presence_segments`、`raw_events`
2. `create_indexes` — 为常用查询字段加索引
3. `add_last_seen_columns` — 增加 `last_seen_at` 列用于安全收尾
4. `add_performance_indexes` — 增加时间范围与未关闭 segment 的复合索引
5. `add_overlap_lookup_indexes` — 增加 `ended_at + started_at` 的跨天查询索引
6. `create_daily_rollups` — 增加按本地日期预聚合的应用、域名和状态日汇总表
7. `create_visible_window_rollups` — 增加 `visible_window_segments` 和 `daily_visible_app_usage`

启动时会自动运行 `restore_unclosed_segments()`，将上次异常退出未关闭的 segment 按最后一次真实观测时间（`last_seen_at`）收尾，避免跨重启的长段。可见窗口历史不从旧焦点数据回填，新版启动后开始自然累积。

`raw_events` 表 capped 在 50,000 行以内，仅用于本地调试。

---

## 前端开发规范

前端骨架与交互有严格约束，见 `docs/frontend-guidelines.md`。核心原则：

- **同构骨架（Structural Skeleton）:** `loading` 与 `loaded` 必须共享同一套 DOM 结构与网格轨道；禁止整棵树替换式骨架。
- **刷新不回退骨架:** 已有历史数据时刷新，默认保留旧数据展示，不回退 skeleton。
- **交互稳定优先:** hover/selected 不得互相抢焦点；图表容器内边距在父层统一处理。

每次改动后必须执行 `npm run build` + `npm run lint` + `npm run test` 并通过手工刷新场景回归。

---

## 测试策略

### 后端测试

```powershell
cargo test -p timeline
cargo test -p common
```

现有测试主要分布在：

- `apps/timeline-backend/src/config.rs` — 配置路径解析、运行时根目录候选、web-ui dist 发现
- `apps/timeline-backend/src/http.rs` — Origin/CORS 校验、扩展请求头识别
- `apps/timeline-backend/src/trackers.rs` — 页面标题记录开关
- `apps/timeline-backend/src/db.rs` — 未关闭 segment 收尾、`last_seen_at` 索引、迁移索引存在性

### 前端测试

- 单元测试：Vitest + jsdom + `@testing-library/react`，配置见 `vitest.config.ts`。
- E2E 测试：Playwright，配置见 `playwright.config.ts`，测试目录 `apps/web-ui/e2e/`。

```powershell
cd apps/web-ui
npm run test      # 单元测试
npm run test:e2e  # E2E 测试
```

---

## 代码风格

### Rust

- 使用 edition 2024。
- 提交前建议保持 `cargo fmt` 与 `cargo clippy` 干净。
- Windows 专用代码使用 `#[cfg(target_os = "windows")]` 或仅在 Windows 上编译（项目当前只支持 Windows）。
- `.cargo/config.toml` 配置了 `target-feature=+crt-static`，release 构建使用静态 CRT。

### 前端

- ESLint 配置使用 flat config (`eslint.config.js`)，包含 `@eslint/js`、`typescript-eslint`、`eslint-plugin-react-hooks`、`eslint-plugin-react-refresh`。
- `npm run lint` 必须通过。
- `npm run build` 必须成功。
- 遵循 `docs/frontend-guidelines.md` 中的骨架与交互规范。

---

## 安全与隐私边界

- 默认只记录应用名、进程信息、窗口标题、域名和活跃状态。
- 默认不记录页面正文、输入内容、剪贴板和截图。
- 数据只保存在本地 SQLite。
- HTTP API 默认仅接受 loopback 来源请求。
- 配置项 `record_window_titles` 与 `record_page_titles` 可分别关闭窗口标题和页面标题记录。
- 浏览器扩展只上报 `http:` / `https:` 协议的域名，不发送完整 URL 参数。

---

## 打包与发布

### 本地构建安装包

前置条件：已安装 Node.js / npm 和 Rust toolchain。

安装包构建还需要安装 Inno Setup 6/7，并确保 `ISCC.exe` 在 PATH 中，或通过 `-InnoSetupCompiler` 显式指定。

```powershell
.\scripts\build-installer.ps1
```

输出位置：`target/installer/output/timeline-setup.exe`

该脚本会：

1. 清理之前的构建产物
2. 构建 `apps/web-ui/dist`
3. 编译 release 版 `timeline.exe`
4. 组装安装源目录（包含默认 `config/timeline.toml`、web-ui dist、扩展、示例配置）
5. 调用 Inno Setup 打包

安装包是普通用户主入口。Inno Setup 脚本 (`installer/timeline.iss`) 关键策略：

- `PrivilegesRequired=lowest` — 不要求管理员权限
- `config/` 与 `data/` 目录标记 `uninsneveruninstall`
- `timeline.toml` 使用 `onlyifdoesntexist` 标志，首次安装写入默认值，后续升级不覆盖

---

## 配置说明

示例配置位于 `config/timeline.example.toml`。主要字段：

- `database_path` — SQLite 文件路径
- `lockfile_path` — 单实例锁文件路径
- `listen_addr` — 本地 HTTP 服务监听地址（默认 `127.0.0.1:46215`）
- `web_ui_url` — 托盘与设置页里展示的 Web UI 地址；空值或默认值会自动指向 `http://<host>:<port>/#/stats`
- `idle_threshold_secs` — 判定 idle 的阈值（秒，默认 300，范围 15~1800）
- `poll_interval_millis` — 轮询间隔（毫秒，默认 1000，范围 250~5000）
- `health_reminder_enabled` — 是否启用连续活跃休息提醒
- `health_reminder_threshold_secs` — 健康提醒触发阈值（秒，默认 3000，范围 300~21600）
- `debug` — 是否启用 debug 级日志与线程名输出
- `tray_enabled` — 是否启用系统托盘
- `record_window_titles` / `record_page_titles` — 是否记录窗口/页面标题
- `log_to_file` — 是否将日志写入文件（按天滚动），Release 构建无控制台，建议保持开启
- `log_dir` — 日志文件目录（相对路径按配置文件所在目录解析）
- `log_retention_days` — 日志文件保留天数，0 表示永不清理
- `debug_events_enabled` — 是否开启 `/api/debug/recent-events` 端点，默认关闭
- `data_retention_days` — 原始 segment 保留天数，超过此天数的已关闭 segment 会在启动时被清理。设为 0 表示永不清理。默认 365 天。daily rollup 汇总表不受此限制，统计与日历数据不会丢失
- `domain_groups` — 域名归组规则，格式 `"组名 = [域名1, 域名2, *.后缀]"`，统计时按归组名聚合
- `ignored_apps` / `ignored_domains` — 忽略列表（支持 `*` 和 `?` 通配符）

配置文件内的相对路径按“配置文件所在目录”解析。

---

## 关键源码文件速查

- `apps/timeline-backend/src/main.rs` — 后端服务入口与启动流程
- `apps/timeline-backend/src/config.rs` — TOML 配置加载、默认值、路径解析
- `apps/timeline-backend/src/trackers.rs` — focus / visible window / presence 轮询与浏览器事件合并逻辑
- `apps/timeline-backend/src/state.rs` — 全局运行时状态（Arc 包裹）
- `apps/timeline-backend/src/db.rs` — SQLite 连接、迁移、读写模型
- `apps/timeline-backend/src/http.rs` — Axum 路由与 CORS/Origin 校验
- `apps/timeline-backend/src/windows.rs` — Win32 API 封装（前台窗口、可见窗口、idle 检测）
- `apps/timeline-backend/src/system.rs` — 托盘、自启动注册表、toast 通知
- `crates/common/src/lib.rs` — 共享 API 类型（envelope、segment、settings 等）
- `apps/browser-extension/service-worker.js` — 扩展核心逻辑（标签页缓存、心跳、上报）
- `apps/browser-extension/content-script.js` — 在 loopback 页面向扩展通知 agent origin
- `apps/web-ui/src/shared/api/client.ts` — 前端 API 客户端与 base URL 解析
- `apps/web-ui/src/app/AppController.tsx` — 前端全局状态与页面路由调度
