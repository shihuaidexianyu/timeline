# 架构设计

> 前端交互与骨架实现规范见：[frontend-guidelines.md](./frontend-guidelines.md)

## 模块划分

- `timeline` 后端负责本地采集、状态合并、SQLite 存储和 HTTP API
- `browser-extension` 负责感知浏览器活动标签页，并把域名事件上报给本地服务
- `web-ui` 负责展示统计分布、应用趋势和专注指标
- `common` 负责共享的数据结构和 API 协议

## 核心数据流

1. Windows 轮询当前前台窗口，并通过当前输入桌面的可见性规则校验 foreground hwnd 后生成窗口快照
2. 快照变化时结束上一条 `focus_segment`，再创建新段
3. Windows 枚举当前输入桌面的顶层窗口，扣除上层窗口遮挡面积后生成 `visible_window_segment`
4. Windows 输入状态轮询产生 `presence_segment`
5. 浏览器扩展在标签切换、URL 变化、窗口焦点变化和心跳时上报域名事件
6. 本地服务只在前台应用确认为浏览器时维护 `browser_segment`
7. Web UI 按日期读取 `focus_segments`、`browser_segments`、`presence_segments`、`visible_window_segments` 和可见窗口预聚合数据
8. Presence 连续 `active` 超过健康阈值时触发本地休息提醒

## segment 规则

### focus_segments

- 启动时先读取一次当前前台窗口
- 只有 foreground hwnd 同时满足当前桌面可见窗口候选条件时才计入：非最小化、未 cloaked、非工具窗口、矩形有效，且扣除上层遮挡后的自身可见比例大于 5%
- 前台焦点校验不使用 25% 屏幕占比阈值，小弹窗、文件选择器等真实焦点窗口仍可计入
- 当窗口指纹变化时结束旧段、创建新段
- 指纹默认由 `hwnd + process_id + window_title` 组成；当关闭窗口标题记录时，采集器不读取标题，指纹退化为 `hwnd + process_id`
- 相同前台窗口连续轮询不会重复建段

### browser_segments

- 扩展会缓存每个浏览器窗口的活动标签页
- 只有“当前聚焦浏览器窗口”的活动标签页才会上报给本地服务
- 相同 `domain + browser_window_id + tab_id` 连续事件会合并
- 域名变化、标签变化、窗口切换或浏览器失焦时结束旧段

### visible_window_segments

- 每个轮询周期枚举当前输入桌面的顶层窗口
- 排除最小化、不可见、DWM cloaked、工具窗口、空矩形窗口和忽略应用
- 按 z-order 计算扣除上层窗口后的实际可见面积
- 计时条件：窗口自身可见比例大于 5%，且实际露出面积至少占所在显示器面积的 25%
- 同一应用多个窗口同时可见时分别记录窗口段，统计页按应用聚合
- 锁屏时关闭当前可见窗口段；idle 不会停止可见窗口计时
- 历史 `focus_segments` 不回填为可见窗口数据

### presence_segments

- `active`：最近输入时间在 idle 阈值内，且当前桌面未锁定
- `idle`：最近输入时间超过 idle 阈值
- `locked`：通过 WTS session flags 判定当前 Windows session 已锁定
- `locked` 优先级高于 `idle`
- 连续 `active` 超过 `health_reminder_threshold_secs` 后只提醒一次，直到进入 `idle/locked` 才重置

## “真实使用时间”口径

- 当前实现把 `presence = active` 视为真实使用时间
- `idle` 和 `locked` 只保留在日明细数据中，不计入 `total_active_seconds`
- 域名总时长当前按浏览器前台事件聚合
- 趋势页应用趋势默认使用可见窗口口径；可切换到前台焦点口径对照
- 趋势页日视图按 10 分钟采样渲染折线图；周/月视图读取应用预聚合趋势
- 统计页应用分布使用同一应用统计口径；历史日期没有可见窗口片段时保持空数据，不回退伪装为焦点数据

## 应用名标准化

当前使用简单的初始映射表：

- `msedge.exe` -> `Microsoft Edge`
- `chrome.exe` -> `Google Chrome`
- `code.exe` -> `Visual Studio Code`
- `wezterm-gui.exe` -> `WezTerm`
- `explorer.exe` -> `Windows Explorer`
