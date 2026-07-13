# 本地 API

统一返回格式：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

错误格式：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "invalid_date",
    "message": "date must use YYYY-MM-DD"
  }
}
```

时间字段统一使用 RFC 3339 UTC 字符串。

## `GET /health`

返回服务状态、启动时间、数据库路径、时区、应用版本、schema 版本和活跃汇总算法版本。

## `GET /api/timeline/day?date=2026-03-21`

返回某一天的 `focus_segments`、`browser_segments` 和 `presence_segments`。

## `GET /api/stats/apps?date=2026-03-21`

按应用聚合当天总时长。`seconds/percentage` 保持原始前台口径，`active_seconds/active_percentage` 是与活跃状态的交集，新版 UI 默认展示后者。域名统计采用相同兼容策略。

## `GET /api/stats/apps/trend?date=2026-03-21&period=week&limit=6`

返回以指定日期为锚点的应用使用趋势，用于周/月折线图。

查询参数：

- `date`：锚点日期，格式为 `YYYY-MM-DD`；省略时使用本地服务时区下的今天
- `period`：`week` 或 `month`，省略时为 `week`
- `limit`：返回前 N 个应用，当前后端会限制在 `1..=12`

响应字段：

- `period`
- `start_date`
- `end_date`
- `timezone`
- `days`：范围内的本地日期数组
- `series`：应用序列数组；旧字段 `total_seconds/daily_seconds` 保留原始口径，新增 `active_total_seconds/active_daily_seconds`
- `active_rollup_status`：活跃统计升级状态与进度

## `GET /api/stats/domains?date=2026-03-21`

按域名聚合当天总时长。

## `GET /api/stats/focus?date=2026-03-21`

返回原始应用前台时长及兼容字段，并新增 `foreground_seconds`、`active_foreground_seconds`、`active_switch_count`、`longest_active_block_seconds` 和 `average_active_block_seconds`。

## `GET /api/calendar/month?month=2026-03`

返回指定自然月的每日汇总，用于使用热度日历。`month` 省略时使用本地服务时区下的当前月份。

响应字段：

- `month`：`YYYY-MM`
- `timezone`：`/health` 返回 Windows 时区 ID；按日数据响应返回该日期起点对应的 UTC offset
- `days`：每日汇总数组，另含 `active_app_seconds`、`active_browser_seconds` 和 `active_switch_count`
- `active_rollup_status`

## `GET /api/stats/summary?date=2026-03-21`

返回以指定日期为锚点的今日、本周、本月汇总。`date` 省略时使用本地服务时区下的今天。

响应字段：

- `date`
- `timezone`
- `today`
- `week`
- `month`

其中 `today` / `week` / `month` 均包含：

- `focus_seconds`
- `active_seconds`
- `foreground_seconds`
- `active_foreground_seconds`

## `GET /api/debug/recent-events`

读取最近的原始事件，仅用于本地调试。

## `GET /api/settings`

返回本地服务运行参数与监视器状态，包含：

- `idle_threshold_secs`
- `poll_interval_millis`
- `health_reminder_enabled`
- `health_reminder_threshold_secs`
- `health_reminder_work_start` / `health_reminder_work_end`
- `health_reminder_quiet_start` / `health_reminder_quiet_end`
- `record_window_titles`
- `record_page_titles`
- `ignored_apps`
- `ignored_domains`
- `recent_apps` / `recent_domains`：供设置页向忽略列表添加最近观测值
- `tracking_paused` / `paused_since` / `pause_until`
- `retention_days` / `database_size_bytes` / `earliest_recorded_date` / `last_backup_at`
- `version` / `schema_version` / `active_rollup_status`

## `POST /api/tracking/pause`

请求体可传 `duration_secs` 或 RFC 3339 `until`，两者不能同时提供；均省略表示暂停到手动恢复。暂停会立即关闭应用/域名段并写入不含敏感内容的 `paused` 状态段。

## `POST /api/tracking/resume`

立即恢复采集并清除持久化的自动恢复时间。

## 数据管理接口

- `GET /api/data/export?format=json|csv&from=YYYY-MM-DD&to=YYYY-MM-DD`：下载日期范围导出；JSON 保留完整结构，CSV 返回包含 `focus.csv`、`browser.csv`、`presence.csv` 的 ZIP 压缩包
- `GET /api/data/backup`：使用 SQLite `VACUUM INTO` 创建一致的在线备份并下载
- `POST /api/data/delete`：`{ from?, to?, all }`，删除前由 UI 二次确认，随后重建汇总
- `POST /api/data/retention`：`{ retention_days: number|null }`，`null` 表示永久保留

## `POST /api/settings/config`

更新采集和提醒配置。健康提醒阈值当前约束为 `300..=21600` 秒。工作时段和静默时段使用本地 `HH:MM`，开始/结束必须成对提交且不能相同，支持跨午夜；新客户端提交一对空字符串可关闭对应限制，旧客户端省略字段时保留现有设置。

## `POST /api/events/browser`

示例：

```json
{
  "domain": "github.com",
  "page_title": "OpenAI / timeline",
  "browser_window_id": 1,
  "tab_id": 214,
  "observed_at": "2026-03-21T11:40:00Z"
}
```

响应表示事件是否被采纳：

```json
{
  "accepted": true,
  "reason": null
}
```

当域名在忽略列表中，或当前前台应用不是浏览器时，`accepted` 为 `false`，并返回原因。
