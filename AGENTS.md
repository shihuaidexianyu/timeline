# timeline

一个面向 Windows 的本地个人活动时间线工具。项目包含 Rust 本地常驻服务、React + Vite 前端，以及 Chrome/Edge Manifest V3 浏览器扩展。所有数据默认保存在本地 SQLite；服务默认监听 loopback，并对浏览器请求执行本地 Origin 校验。

文档、注释和 UI 文案以中文为主。

---

## 项目概述

`timeline` 在 Windows 本地记录：

- 前台应用（进程名、应用显示名、可执行路径、可选窗口标题）
- 浏览器前台标签页的域名（通过浏览器扩展上报）
- 设备使用状态：`active` / `idle` / `locked` / `paused`

数据写入本地 SQLite，由本地 Web UI 渲染为每日时间线、应用/域名分布、应用周/月趋势、专注统计、使用热度日历和设置页。后端会托管找到的 Web UI 构建产物（仓库开发构建位于 `apps/web-ui/dist`，安装包内位于 `web-ui/dist`）；前端未构建时 API 仍可用，但页面 fallback 会返回 503 提示。

`timeline.exe` 直接启动采集服务、HTTP API 和系统托盘。内置在线升级机制已移除；版本更新通过重新安装新版本安装包完成，安装包升级不会覆盖用户的 `config/` 与 `data/`。

---

## 项目结构

```text
timeline/
├── Cargo.toml                 # Workspace 根配置
├── Cargo.lock                 # Rust 锁定依赖
├── .cargo/config.toml         # Windows 静态 CRT 链接配置
├── apps/
│   ├── timeline-backend/      # Rust 后端（包名 timeline，可执行文件 timeline.exe，含 ico 资源）
│   ├── web-ui/                # React + Vite 前端
│   └── browser-extension/     # Manifest V3 浏览器扩展
├── crates/
│   └── common/                # Rust API 协议模型（serde 类型）
├── docs/
│   ├── architecture.md        # 架构与数据流说明
│   ├── api.md                 # 本地 HTTP API 文档
│   ├── schema.md              # SQLite 表结构说明
│   └── frontend-guidelines.md # 前端骨架与交互规范（必读）
├── scripts/
│   ├── build-installer.ps1    # 构建面向用户的 Windows 安装包
│   └── generate-icons.ps1     # 统一生成后端、前端与扩展图标
├── installer/
│   └── timeline.iss           # Inno Setup 安装包脚本
├── config/
│   └── timeline.example.toml  # 配置示例
└── README.md                  # 用户向运行与安装说明
```

---

## 技术栈

- **后端:** Rust (edition 2024)，Tokio 异步运行时，Axum Web 框架，SQLx + SQLite，tower-http 静态文件/CORS，tao + tray-icon（系统托盘），windows/winreg 等 Windows 原生 API；Toast 直接使用 Windows Runtime 通知 API。
- **前端:** React 19，Vite 8，TypeScript ~5.9，ECharts 6，react-calendar-timeline，dayjs，interactjs，TanStack Query。
- **扩展:** 原生 JavaScript，Chrome Extension Manifest V3（service worker + content script）。
- **构建脚本:** PowerShell（`*.ps1`），仅支持 Windows。
- **测试:** 后端 `cargo test`；前端 Vitest + jsdom + Testing Library 做单元测试，Playwright 做 E2E 测试。

---

## 构建与运行命令

### 启动后端

若要由后端同时提供 Web UI，先运行一次 `apps/web-ui` 的生产构建；未构建时根页面返回“前端尚未构建”，不影响 API。

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
npm ci
npm run dev
```

开发服务器端口为 `4173`。在 Vite 的 `4173`/`5173` 本地开发地址下，前端默认调用 `http://127.0.0.1:46215`；生产构建默认调用页面同源 API。如需覆盖，可设置 `VITE_API_BASE_URL`。

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
- `config.rs` — TOML 配置加载、旧配置名兼容、默认值、路径解析、运行时根目录发现、web-ui dist 目录搜索。
- `trackers.rs` — focus / presence 轮询，以及浏览器事件合并逻辑。
- `state.rs` — 全局运行时状态（`AgentState`，Arc 包裹），包含当前 focus/browser/presence segment、可热更新的配置快照、健康提醒状态、监视器心跳与退出信号。
- `db.rs` — SQLite 连接、迁移、segment 读写、日汇总维护/重建、统计聚合、月历/周期/应用趋势查询。
- `http.rs` — Axum 路由、静态 Web UI fallback、CORS/Origin 校验、统一 API 信封、设置接口、浏览器事件接收。
- `windows.rs` — Win32 API 封装：前台窗口、idle 时长、工作站锁定检测。
- `timezone.rs` — Windows 动态时区上下文、历史日期 UTC 边界与固定 offset 测试实现。
- `system.rs` — 系统托盘、开机自启动注册表、开始菜单快捷方式、toast/对话框通知、打开前端 URL 与优雅退出。

### 共享类型 (`crates/common/src/lib.rs`)

定义后端使用的 Rust API 协议类型。前端不会直接编译这个 crate，而是在 `apps/web-ui/src/shared/api/types.ts` 中维护对应的 TypeScript 镜像；修改响应或请求结构时必须同步两处以及 `docs/api.md`。浏览器扩展使用原生 JavaScript 对象构造 `BrowserEventPayload`。

`scripts/check-protocol-sync.ps1` 会比较 Rust/TypeScript 镜像结构的字段顺序和枚举值，CI 必须通过；它不能替代类型语义审查，字段类型变化仍需同步检查两端。

- `ApiResponse<T>` / `ApiErrorBody` / `HealthResponse` — 统一 API 信封与健康状态
- `PresenceState` / `AppInfo` / `FocusSegment` / `BrowserSegment` / `PresenceSegment`
- `TimelineDayResponse` / `DurationStat` / `FocusStats`
- `AgentSettingsResponse` / `UpdateAgentConfigRequest` / `UpdateAutostartRequest`
- `BrowserEventPayload` / `BrowserEventAck`
- `DebugEvent` / `DaySummary` / `MonthCalendarResponse` / `PeriodSummaryResponse`
- `TrendPeriod` / `AppUsageTrendSeries` / `AppUsageTrendResponse`

### 前端 (`apps/web-ui/src/`)

- `app/` — 应用级壳、Hash 路由、日期/视口状态、React Query 数据调度
- `shared/api/` — API 客户端、React Query hooks、TypeScript 类型
- `shared/ui/` — 通用 UI 组件（Button、Panel、Switch、SkeletonBlock 等）
- `pages/` — stats-page、timeline-page、settings-page
- `components/` — timeline-chart、donut-chart、calendar-grid、app-usage-trend-chart 等
- `features/` — 按领域拆分的选择器与表单逻辑
- `lib/` — 图表模型、仪表盘辅助函数、主题
- `hooks/` — use-theme 等自定义 hook
- `src/api.ts` — 兼容入口，仅重新导出 `shared/api`

### 浏览器扩展 (`apps/browser-extension/`)

- `manifest.json` — Manifest V3，版本从根 workspace 版本同步
- `service-worker.js` — 扩展事件协调；校验、发现、串行传输和状态分别在 `validation.js`、`discovery.js`、`transport.js`、`state.js`
- `popup.html` / `popup.js` — 显示连接、当前域名、最后成功时间并提供暂停/恢复
- `content-script.js` — 在 loopback 页面向扩展通知 agent origin

---

## 核心数据流

1. **Focus Tracker:** 按 `poll_interval_millis` 轮询 Windows 前台窗口（`GetForegroundWindow`），窗口指纹（`hwnd + process_id + window_title`）变化时结束旧 `focus_segment` 并创建新段；关闭窗口标题记录时指纹退化为 `hwnd + process_id`。同一段持续观测更新内存最后观测时间，`last_seen_at` 默认每 10 秒批量落盘。
2. **Presence Tracker:** 以同一轮询间隔检测用户输入 idle 时长与工作站锁定状态，生成 `presence_segment`（状态：`active` / `idle` / `locked` / `paused`）。暂停会立即关闭应用和域名段；连续 idle/locked/paused 达 3 分钟才重置健康提醒。提醒可限制在工作时段并避开静默时段，两个本地时间窗口都支持跨午夜；Toast 提供“稍后 10 分钟”“已休息”“今天不再提醒”，对话框仅在 Toast 创建失败时兜底且不置顶。
3. **Browser Bridge:** 扩展仅上报“当前聚焦浏览器窗口”的活动标签页，协议仅接受 `http:` / `https:`，载荷包含 hostname 而非完整 URL。后端仅在确认 Chrome / Edge / Firefox / Brave 为前台时维护 `browser_segment`；相同 `domain + browser_window_id + tab_id` 连续事件只 touch 当前段，早于当前开放段最后观测时间的乱序事件被拒绝。
4. **Rollup:** 原始前台汇总写入 `daily_*_usage`；应用/域名与 active 状态的交集写入 `daily_active_*_usage`。活跃历史汇总按算法版本异步、逐日事务重建，进度和续跑日期存于 `rollup_rebuild_jobs`。
5. **Web UI:** React Query 按日期读取时间线、周期汇总、月历与应用趋势，使用 `keepPreviousData` 保留刷新/切换期间的已有数据，再渲染统计、时间线和设置页。

日期是 Hash URL 状态的一部分，首次确定今天后写入 URL，浏览器前进/后退会恢复日期。ECharts 仅随统计页 lazy chunk 加载，图表使用显式解析主题 token；时间线搜索预计算文本，应用/域名关联使用按时间排序的 interval sweep。

focus、presence、browser、配置热更新、暂停/恢复与退出共享统一串行采集协调门；segment 切换和退出立即 flush，今日时间线把内存中的开放段增量合并到数据库查询结果。

暂停支持 15 分钟、1 小时、到下一个本地午夜或手动恢复。暂停计划写入运行设置并可跨重启恢复；设置页和托盘都会显示当前状态，托盘菜单可直接暂停或恢复，截止时间按当前 Windows 时区显示。

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

CORS/Origin 限制：带 `Origin` 的普通浏览器请求必须来自 loopback（`127.0.0.1`、`localhost`、`::1`）。浏览器扩展需带上自定义请求头 `X-Timeline-Extension: browser-bridge`；`chrome-extension://` 来源仅在带有正确请求头时被允许。无 `Origin` 的本地客户端请求不会被该中间件拒绝，因此不要把 CORS 当成身份认证，也不要随意把 `listen_addr` 改为非 loopback 地址。

主要端点：

- `GET /health`
- `GET /api/timeline/day?date=YYYY-MM-DD`
- `GET /api/stats/apps?date=YYYY-MM-DD`
- `GET /api/stats/apps/trend?date=YYYY-MM-DD&period=week|month&limit=1..12`
- `GET /api/stats/domains?date=YYYY-MM-DD`
- `GET /api/stats/focus?date=YYYY-MM-DD`
- `GET /api/stats/summary?date=YYYY-MM-DD`
- `GET /api/calendar/month?month=YYYY-MM`
- `GET /api/debug/recent-events`
- `GET /api/settings`
- `POST /api/settings/config`
- `POST /api/settings/autostart`
- `POST /api/events/browser`
- `POST /api/tracking/pause` / `POST /api/tracking/resume`
- `GET /api/data/export` / `GET /api/data/backup`
- `POST /api/data/delete` / `POST /api/data/retention`

成功生成 SQLite 在线备份后会把 RFC 3339 时间写入 `runtime_settings.last_backup_at`；设置响应和数据管理区展示最近一次成功备份时间。

设置页的数据管理区支持日期范围 JSON/CSV 导出、SQLite 在线备份、日期范围删除和全量删除。删除操作必须经过两次确认；范围删除会拆分跨越边界的 segment，并重建受影响的日汇总。

保留策略按本地自然日计算，当前日期计为第 1 天；例如“90 天”保留今天和此前 89 个本地日期。后台启动时执行一次，之后每 24 小时增量清理更早的 segment、raw event 和日汇总。

详见 `docs/api.md`。

日期参数省略时使用 Windows 动态时区在请求时刻对应的今天/当前月份。`POST /api/settings/config` 只更新运行时配置快照中的采集、提醒与忽略列表字段，保存成功后立即生效并返回 `requires_restart: false`；路径、监听地址、托盘与 debug 等启动配置不由这个接口修改。

---

## 数据库与迁移

后端使用 SQLx + SQLite，表结构在 `db.rs` 的 `MIGRATIONS` 常量中定义。当前包含 7 个版本迁移：

1. `create_core_tables` — 创建 `app_registry`、`focus_segments`、`browser_segments`、`presence_segments`、`raw_events`
2. `create_indexes` — 为常用查询字段加索引
3. `add_last_seen_columns` — 增加 `last_seen_at` 列用于安全收尾
4. `add_performance_indexes` — 增加时间范围与未关闭 segment 的复合索引
5. `add_overlap_lookup_indexes` — 增加 `ended_at + started_at` 的跨天查询索引
6. `create_daily_rollups` — 增加按本地日期预聚合的应用、域名和状态日汇总表
7. `create_active_rollups_and_runtime_settings` — 增加活跃交集汇总、重建任务与运行设置表

不要修改已发布迁移的 SQL 或版本号；任何 schema 变更都应追加新迁移，并同步 `docs/schema.md` 与本节。迁移记录写入 `schema_migrations`。

SQLite 连接启用 WAL 与 `synchronous=NORMAL`。启动顺序是：执行迁移 → `restore_unclosed_segments()` → `ensure_daily_rollups()`。异常退出留下的开放 segment 会按最后一次真实观测时间（`last_seen_at`，回退到 `started_at`）收尾，避免跨重启的长段；日汇总版本、算法或 Windows 时区 ID 缺失/变化时从原始 segment 重建。日边界通过 Windows 动态时区规则计算，支持 DST 的 23/25 小时日；运行中每 5 分钟检查系统时区 ID，变化后热更新并重建汇总。

原始日汇总表为 `daily_app_usage`、`daily_domain_usage`、`daily_presence_usage`，活跃交集汇总表为 `daily_active_app_usage`、`daily_active_domain_usage`；版本与重建状态分别保存在 `rollup_metadata`、`rollup_rebuild_jobs`。segment 的 touch/结束更新与对应 rollup 增量写入在同一事务内完成，`segment_count` 在结束或异常恢复时补记；修改 segment 写入逻辑时要同时验证跨日拆分、计数、active 交集和回填逻辑。

`raw_events` 表保留最近 50,000 行，仅用于本地调试；`GET /api/debug/recent-events` 当前只返回最近 30 条。

每日保留策略清理按完整本地日期删除截止日前的原始段、raw events 和 rollup，跨截止日 segment 会裁剪到保留边界；该维护不触发全量 rollup 重建，用户主动范围删除才重建汇总。

---

## 前端开发规范

前端骨架与交互有严格约束，见 `docs/frontend-guidelines.md`。核心原则：

- **同构骨架（Structural Skeleton）:** `loading` 与 `loaded` 必须共享同一套 DOM 结构与网格轨道；禁止整棵树替换式骨架。
- **刷新不回退骨架:** 已有历史数据时刷新，默认保留旧数据展示，不回退 skeleton。
- **交互稳定优先:** hover/selected 不得互相抢焦点；图表容器内边距在父层统一处理。

每次前端改动后必须执行 `npm run check`（lint + Vitest + build）并通过手工刷新场景回归；涉及路由、查询流程、响应式布局或关键交互时再执行 `npm run test:e2e`。Playwright 同时跑桌面 Chromium 与 Pixel 5 模拟项目。

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
- `apps/timeline-backend/src/db.rs` — 未关闭 segment 收尾、迁移回滚、原始/活跃日汇总、DST、历史回填、范围删除、保留边界和在线备份

`common` 当前主要通过编译保证协议模型正确，没有独立单元测试；协议字段变化至少要同时运行后端测试和前端测试。

### 前端测试

- 单元测试：Vitest + jsdom + `@testing-library/react`，配置见 `vitest.config.ts`。
- 单元测试覆盖 API envelope、设置表单转换、统计/时间线 selector、图表模型与时间线颜色。
- E2E 测试：Playwright，配置见 `playwright.config.ts`，测试目录 `apps/web-ui/e2e/`；API 由 route mock 提供，覆盖统计/时间线基础渲染、域名搜索、主题、隐私提示、Hash 日期历史、键盘操作、ECharts lazy chunk、提醒时段、暂停和范围删除，并同时检查桌面 Chromium 与 Pixel 5。

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
- 数据库 schema 只通过追加 `MIGRATIONS` 演进，不直接改写旧迁移。

### 前端

- ESLint 配置使用 flat config (`eslint.config.js`)，包含 `@eslint/js`、`typescript-eslint`、`eslint-plugin-react-hooks`、`eslint-plugin-react-refresh`。
- `npm run check` 必须通过。
- 遵循 `docs/frontend-guidelines.md` 中的骨架与交互规范。
- API 类型以 `crates/common/src/lib.rs` 为后端契约，修改时同步 `shared/api/types.ts`、client/query、mock 与文档。

---

## 安全与隐私边界

- 默认只记录应用名、进程信息、窗口标题、域名和活跃状态。
- 默认不记录页面正文、输入内容、剪贴板和截图；新安装默认不记录页面标题。
- Web UI 首次打开会解释窗口标题、页面标题和域名的差异；确认状态仅写入浏览器本地存储。
- 数据只保存在本地 SQLite；没有云同步或遥测上传。
- HTTP API 默认仅接受 loopback 来源请求。
- 配置项 `record_window_titles` 与 `record_page_titles` 可分别关闭窗口标题和页面标题记录。
- 浏览器扩展拥有 `tabs` 权限以读取活动标签信息，但只向 agent 上报 `http:` / `https:` 页面的 hostname、可选页面标题、窗口/标签 ID 与观测时间，不发送完整 URL 参数。
- `ignored_apps` 与 `ignored_domains` 当前均为忽略大小写的精确匹配，不支持 glob、正则或父域自动匹配。
- Origin/CORS 只约束浏览器访问；真正的网络隔离依赖 `listen_addr` 保持 loopback。

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

1. 清理前端缓存和旧安装 staging；仅在显式传入 `-Clean` 时执行 `cargo clean`
2. 构建 `apps/web-ui/dist`
3. 编译 release 版 `timeline.exe`
4. 组装安装源目录（包含默认 `config/timeline.toml`、web-ui dist、扩展、示例配置）
5. 调用 Inno Setup 打包

`-SkipBuild` 只跳过前端/Rust 编译，仍要求已有的 `target/release/timeline.exe` 与 `apps/web-ui/dist/index.html`；`-Clean` 用于显式丢弃 Cargo 构建缓存。图标变化先运行 `./scripts/generate-icons.ps1`，它会同步浏览器扩展 PNG、Web favicon 和后端 `timeline.ico`。

扩展 staging 只复制运行时的 manifest、JS/HTML/CSS 与 `icons/`，不得把测试、`package.json` 或开发文档装入用户目录。

安装包是普通用户主入口。Inno Setup 脚本 (`installer/timeline.iss`) 关键策略：

- `PrivilegesRequired=lowest` — 不要求管理员权限
- `config/` 与 `data/` 目录标记 `uninsneveruninstall`
- `timeline.toml` 使用 `onlyifdoesntexist` 标志，首次安装写入默认值，后续升级不覆盖
- 安装目录默认是 `{localappdata}\Programs\Timeline`，静态 `web-ui/`、`browser-extension/` 和 `timeline.exe` 会在卸载时清理
- 交互卸载可选择同时删除 `config/` 与 `data/`，默认按钮为“否”；静默卸载始终保留本地数据
- 简体中文安装器语言文件固定随仓库提供于 `installer/ChineseSimplified.isl`，不得依赖构建机额外安装 Inno 语言包

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
- `health_reminder_work_start` / `health_reminder_work_end` — 可选工作时段，本地 `HH:MM`，必须成对配置
- `health_reminder_quiet_start` / `health_reminder_quiet_end` — 可选静默时段，支持跨午夜
- `debug` — 是否启用 debug 级日志、线程名与完整 raw payload；新安装默认关闭
- `tray_enabled` — 是否启用系统托盘
- `record_window_titles` / `record_page_titles` — 是否记录窗口/页面标题
- `ignored_apps` / `ignored_domains` — 忽略列表

设置响应还会返回 `recent_apps` / `recent_domains`（最多各 20 项），设置页使用精确 key 快捷加入忽略列表；匹配语义仍是忽略大小写的精确匹配。

若未传 `--config`，运行时根目录优先从 `TIMELINE_INSTALL_ROOT`、可执行文件父级候选和当前目录推断；默认读取 `config/timeline.toml`，并兼容旧名 `config/timeline-agent.toml`。显式 `--config` 的相对路径按当前工作目录解析。

已存在配置文件中的 `database_path` / `lockfile_path` 相对路径按“配置文件所在目录”解析；使用不存在的默认配置时，相对默认路径按运行时根目录解析。`web_ui_url` 为空、仍为旧开发地址或等于默认地址时，会根据实际 `listen_addr` 生成自托管 `/#/stats` 地址。

设置页/API 可热更新：`idle_threshold_secs`、`poll_interval_millis`、健康提醒开关/阈值/工作时段/静默时段、两项标题记录开关和两个忽略列表。`database_path`、`lockfile_path`、`listen_addr`、`web_ui_url`、`debug`、`tray_enabled` 属于启动配置；需要手工编辑配置并重启。

---

## 关键源码文件速查

- `apps/timeline-backend/src/main.rs` — 后端服务入口与启动流程
- `apps/timeline-backend/src/config.rs` — TOML 配置加载、默认值、路径解析
- `apps/timeline-backend/src/trackers.rs` — focus / presence 轮询与浏览器事件合并逻辑
- `apps/timeline-backend/src/state.rs` — 全局运行时状态（Arc 包裹）
- `apps/timeline-backend/src/db.rs` — SQLite 连接、迁移、读写模型
- `apps/timeline-backend/src/http.rs` — Axum 路由与 CORS/Origin 校验
- `apps/timeline-backend/src/windows.rs` — Win32 API 封装（前台窗口、idle 检测）
- `apps/timeline-backend/src/timezone.rs` — Windows 动态时区与 DST 日边界
- `apps/timeline-backend/src/system.rs` — 托盘、自启动注册表、toast 通知
- `crates/common/src/lib.rs` — 共享 API 类型（envelope、segment、settings 等）
- `apps/browser-extension/service-worker.js` — 扩展核心逻辑（标签页缓存、心跳、上报）
- `apps/browser-extension/content-script.js` — 在 loopback 页面向扩展通知 agent origin
- `apps/web-ui/src/shared/api/client.ts` — 前端 API 客户端与 base URL 解析
- `apps/web-ui/src/shared/api/types.ts` — 与 Rust 协议手动同步的 TypeScript 类型
- `apps/web-ui/src/shared/api/queries.ts` — React Query key、查询与设置 mutation
- `apps/web-ui/src/app/AppController.tsx` — 前端全局状态与页面路由调度
- `apps/web-ui/src/lib/chart-model.ts` — segment 裁剪、聚合与图表模型
- `scripts/build-installer.ps1` / `installer/timeline.iss` — 安装 staging 与 Inno Setup 策略
