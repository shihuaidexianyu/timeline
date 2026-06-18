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

返回服务状态、启动时间、数据库路径和时区信息。

## `GET /api/timeline/day?date=2026-03-21`

返回某一天的 `focus_segments`、`browser_segments` 和 `presence_segments`。

## `GET /api/stats/apps?date=2026-03-21`

按应用聚合当天总时长。

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
- `series`：应用序列数组，包含 `key`、`label`、`total_seconds`、`daily_seconds`

## `GET /api/stats/domains?date=2026-03-21`

按域名聚合当天总时长。

## `GET /api/stats/focus?date=2026-03-21`

返回专注总时长、真实使用时间、切换次数、最长专注块和平均专注块。

## `GET /api/calendar/month?month=2026-03`

返回指定自然月的每日汇总，用于使用热度日历。`month` 省略时使用本地服务时区下的当前月份。

响应字段：

- `month`：`YYYY-MM`
- `timezone`：本地服务启动时解析到的 UTC offset
- `days`：每日汇总数组，包含 `focus_seconds`、`active_seconds`、`browser_seconds`、`switch_count`、`top_app`、`top_domain`

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

## `GET /api/debug/recent-events`

读取最近的原始事件，仅用于本地调试。

## `GET /api/settings`

返回本地服务运行参数与监视器状态，包含：

- `idle_threshold_secs`
- `poll_interval_millis`
- `health_reminder_enabled`
- `health_reminder_threshold_secs`
- `record_window_titles`
- `record_page_titles`
- `ignored_apps`
- `ignored_domains`

## `POST /api/settings/config`

更新采集和提醒配置。健康提醒阈值当前约束为 `300..=21600` 秒。

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
