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

- `state`：`active` / `idle` / `locked` / `paused`
- `started_at`
- `ended_at`
- `last_seen_at`：最后一次真实观测到该状态仍然有效的时间

## `raw_events`

- `kind`
- `payload_json`
- `observed_at`

`raw_events` 启动后持续限制在最近 50,000 行以内，只用于本地调试。`debug=false` 时 `payload_json` 不保存完整采集载荷。

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
- `state`：`active` / `idle` / `locked` / `paused`
- `seconds`
- `segment_count`
- `updated_at`

主键：`(date, state)`。

## `rollup_metadata`

记录原始日汇总版本、活跃交集算法版本和 Windows 时区 ID。当前原始汇总版本与活跃算法版本均为 `2`；版本或时区 ID 变化会触发重建。

## `daily_active_app_usage` / `daily_active_domain_usage`

只累计应用/域名区间与 `presence=active` 区间的交集。字段与对应原始日汇总基本一致；新版 UI 默认使用这里的时长，原始 `daily_*_usage` 继续保留兼容口径。

## `rollup_rebuild_jobs`

记录活跃汇总重建的 `pending/running/ready/failed` 状态、完成天数、总天数、下一日期与最近错误。每个日期的活跃应用/域名重建和进度推进在同一事务中提交；中断或失败后保留已经完成的日期，下一次启动从 `next_date` 续跑。HTTP 启动不等待活跃汇总重建完成。

## `runtime_settings`

保存暂停截止时间、数据保留天数和最后备份时间等非敏感运行设置。

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
7. `create_active_rollups_and_runtime_settings`
