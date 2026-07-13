# 架构设计

> 前端交互与骨架实现规范见：[frontend-guidelines.md](./frontend-guidelines.md)

## 模块划分

- `timeline` 后端负责本地采集、状态合并、SQLite 存储和 HTTP API
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
7. 应用/域名原始段与 `presence=active` 做区间交集，生成默认统计口径
8. Presence 连续 `active` 超过健康阈值时触发本地休息提醒

采集状态转换由统一串行协调门保护。focus、presence、browser、配置热更新、暂停/恢复和退出可以并发接收 observation，但不会并发改写开放 segment。同段最后观测时间默认每 10 秒批量落盘，切段和退出立即 flush；今日 API 使用内存观测时间补齐未提交增量。

暂停截止时间保存在 `runtime_settings`，重启后继续生效；到期由后端自动恢复。设置页和系统托盘共享相同的暂停/恢复入口，“暂停到明天”按 Windows 动态时区计算下一个本地午夜。

每日保留策略维护直接删除截止日前的原始段、诊断事件和日汇总，并裁剪跨截止日区间；保留日期的汇总不做无意义全量重建。用户主动范围删除仍会重建受影响汇总。

## segment 规则

### focus_segments

- 启动时先读取一次当前前台窗口
- 当窗口指纹变化时结束旧段、创建新段
- 指纹默认由 `hwnd + process_id + window_title` 组成；当关闭窗口标题记录时，采集器不读取标题，指纹退化为 `hwnd + process_id`
- 相同前台窗口连续轮询不会重复建段，`last_seen_at` 默认每 10 秒批量持久化

### browser_segments

- 扩展会缓存每个浏览器窗口的活动标签页
- 只有“当前聚焦浏览器窗口”的活动标签页才会上报给本地服务
- 相同 `domain + browser_window_id + tab_id` 连续事件会合并
- 早于当前开放浏览器段最后观测时间的乱序事件会被拒绝
- 域名变化、标签变化、窗口切换或浏览器失焦时结束旧段

### presence_segments

- `active`：最近输入时间在 idle 阈值内，且当前桌面未锁定
- `idle`：最近输入时间超过 idle 阈值
- `locked`：输入桌面切换到 `Winlogon` 或其他非默认桌面
- `paused`：用户主动暂停，段内不包含应用、域名和标题
- `locked` 优先级高于 `idle`
- 连续 `active` 超过阈值后只提醒一次；仅在可选工作时段内且不在静默时段内触发，两个时间窗口都支持跨午夜
- Toast 提供“稍后 10 分钟”“已休息”“今天不再提醒”；动作会更新内存提醒状态并写入非敏感诊断事件
- `idle/locked/paused` 连续达到 3 分钟才完成休息并重置提醒状态

## 活跃应用口径

- 当前实现把 `presence = active` 视为真实使用时间
- `idle` 和 `locked` 只保留在时间线中，不计入 `total_active_seconds`
- 应用和域名默认统计为其原始区间与 active 区间的交集
- 原始前台时长继续保存在 `daily_app_usage` / `daily_domain_usage` 和兼容 API 字段中
- 活跃重建在 HTTP 启动后异步执行；每个本地日期独立事务提交并更新 `next_date`，异常退出后从下一日期续跑，状态通过 `active_rollup_status` 暴露
- 日边界由 Windows 动态时区信息计算，不使用启动时固定 offset；DST 前进/回退日分别按 23/25 小时累计。服务每 5 分钟检查 Windows 时区 ID，变化后热替换时区上下文并重建原始与活跃日汇总

## 应用名标准化

当前使用简单的初始映射表：

- `msedge.exe` -> `Microsoft Edge`
- `chrome.exe` -> `Google Chrome`
- `code.exe` -> `Visual Studio Code`
- `wezterm-gui.exe` -> `WezTerm`
- `explorer.exe` -> `Windows Explorer`
