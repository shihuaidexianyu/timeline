# 数据表说明

## `app_registry`

- `process_name`：进程名，唯一键
- `display_name`：用户友好的应用名

## `focus_segments`

- `process_name`
- `display_name`
- `exe_path`
- `window_title`
- `is_browser`
- `started_at`
- `ended_at`
- `last_seen_at`：最后一次真实观测到该段仍然有效的时间，用于异常退出后的安全收尾

## `browser_segments`

- `domain`
- `page_title`
- `browser_window_id`
- `tab_id`
- `started_at`
- `ended_at`
- `last_seen_at`：最后一次真实观测到该段仍然有效的时间

## `presence_segments`

- `state`
- `started_at`
- `ended_at`
- `last_seen_at`：最后一次真实观测到该状态仍然有效的时间

## `raw_events`

- `kind`
- `payload_json`
- `observed_at`

`raw_events` 启动后持续 capped 在最近 50,000 行以内，只用于本地调试。

## `daily_app_usage`

按本地日期预聚合应用使用时长，供统计页、月历和应用趋势图快速读取。

- `date`：本地日期，格式为 `YYYY-MM-DD`
- `process_name`
- `display_name`
- `seconds`：该日期内累计应用前台时长
- `segment_count`：该日期内覆盖到的应用片段数量
- `updated_at`

主键：`(date, process_name)`。

## `daily_domain_usage`

按本地日期预聚合浏览器域名使用时长。

- `date`
- `domain`
- `seconds`
- `segment_count`
- `updated_at`

主键：`(date, domain)`。

## `daily_presence_usage`

按本地日期预聚合设备状态时长。

- `date`
- `state`：`active` / `idle` / `locked`
- `seconds`
- `segment_count`
- `updated_at`

主键：`(date, state)`。

## `rollup_metadata`

记录预聚合数据版本。服务启动时如果发现 `daily_rollup_version` 缺失或过期，会从原始 segment 表重建日汇总。

## `schema_migrations`

- `version`
- `name`
- `applied_at`

本地服务启动时自动执行 `db.rs` 中定义的迁移，并用该表记录已经应用的版本。

## 当前迁移

1. `create_core_tables`
2. `create_indexes`
3. `add_last_seen_columns`
4. `add_performance_indexes`
5. `add_overlap_lookup_indexes`
6. `create_daily_rollups`
