# 架构设计

> 前端交互与骨架实现规范见：[frontend-guidelines.md](./frontend-guidelines.md)

## 模块划分

- `timeline-agent` 负责本地采集、状态合并、SQLite 存储和 HTTP API
- `browser-extension` 负责感知浏览器活动标签页，并把域名事件上报给本地服务
- `web-ui` 负责展示每日时间线、统计分布和专注指标
- `common` 负责共享的数据结构和 API 协议

## 核心数据流

1. Windows 轮询当前前台窗口，生成窗口快照
2. 快照变化时结束上一条 `focus_segment`，再创建新段
3. Windows 输入状态轮询产生 `presence_segment`
4. 浏览器扩展在标签切换、URL 变化、窗口焦点变化和心跳时上报域名事件
5. 本地服务只在前台应用确认为浏览器时维护 `browser_segment`
6. Web UI 按日期读取 `focus_segments`、`browser_segments` 和 `presence_segments`
7. Presence 连续 `active` 超过健康阈值时触发本地休息提醒

## segment 规则

### focus_segments

- 启动时先读取一次当前前台窗口
- 当窗口指纹变化时结束旧段、创建新段
- 指纹由 `hwnd + process_id + window_title` 组成
- 相同前台窗口连续轮询不会重复建段

### browser_segments

- 扩展会缓存每个浏览器窗口的活动标签页
- 只有“当前聚焦浏览器窗口”的活动标签页才会上报给本地服务
- 相同 `domain + browser_window_id + tab_id` 连续事件会合并
- 域名变化、标签变化、窗口切换或浏览器失焦时结束旧段

### presence_segments

- `active`：最近输入时间在 idle 阈值内，且当前桌面未锁定
- `idle`：最近输入时间超过 idle 阈值
- `locked`：输入桌面切换到 `Winlogon` 或其他非默认桌面
- `locked` 优先级高于 `idle`
- 连续 `active` 超过 `health_reminder_threshold_secs` 后只提醒一次，直到进入 `idle/locked` 才重置

## “真实使用时间”口径

- 当前版本把 `presence = active` 视为真实使用时间
- `idle` 和 `locked` 只保留在时间线中，不计入 `total_active_seconds`
- 应用与域名总时长当前按时间线原始时长聚合

## 应用名标准化

当前使用简单的初始映射表：

- `msedge.exe` -> `Microsoft Edge`
- `chrome.exe` -> `Google Chrome`
- `code.exe` -> `Visual Studio Code`
- `wezterm-gui.exe` -> `WezTerm`
- `explorer.exe` -> `Windows Explorer`
