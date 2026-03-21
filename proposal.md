# timeline proposal

## 一句话定位

Windows 本地个人注意力时间线系统。

## MVP 边界

第一阶段只做下面这些能力：

- 单机运行，不做云同步
- 本地 SQLite 存储，不做账户系统
- 记录 Windows 前台应用时间线
- 记录浏览器前台标签页的域名时间线
- 识别 `active / idle / locked` 三种设备使用状态
- 提供本地 HTTP API 和本地网页时间线界面

明确不进入 MVP 的内容：

- 截图
- 页面正文采集
- 完整 URL 参数跟踪
- AI 自动分类
- 多设备同步
- 复杂权限与账户体系

## 本轮落地决策

- 后端：Rust
- 异步运行时：Tokio
- HTTP：Axum
- 数据库：SQLite
- 配置：TOML
- 日志：`tracing` + `tracing-subscriber`
- 前端：React + Vite
- 浏览器扩展：Manifest V3，优先兼容 Edge 和 Chrome
- 扩展与本地服务通信：本地 HTTP
