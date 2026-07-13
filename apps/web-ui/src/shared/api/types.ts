export type PresenceState = 'active' | 'idle' | 'locked' | 'paused'

export type AppInfo = {
  process_name: string
  display_name: string
  exe_path: string | null
  window_title: string | null
  is_browser: boolean
}

export type FocusSegment = {
  id: number
  started_at: string
  ended_at: string | null
  app: AppInfo
}

export type BrowserSegment = {
  id: number
  domain: string
  page_title: string | null
  browser_window_id: number
  tab_id: number
  started_at: string
  ended_at: string | null
}

export type PresenceSegment = {
  id: number
  state: PresenceState
  started_at: string
  ended_at: string | null
}

export type TimelineDayResponse = {
  date: string
  timezone: string
  focus_segments: FocusSegment[]
  browser_segments: BrowserSegment[]
  presence_segments: PresenceSegment[]
}

export type DurationStat = {
  key: string
  label: string
  seconds: number
  percentage: number
  active_seconds: number
  active_percentage: number
}

export type FocusStats = {
  total_focus_seconds: number
  total_active_seconds: number
  switch_count: number
  longest_focus_block_seconds: number
  average_focus_block_seconds: number
  foreground_seconds: number
  active_foreground_seconds: number
  active_switch_count: number
  longest_active_block_seconds: number
  average_active_block_seconds: number
}

export type ActiveRollupStatus = {
  status: 'pending' | 'running' | 'ready' | 'failed'
  completed_days: number
  total_days: number
  next_date: string | null
  last_error: string | null
  updated_at: string | null
}

export type HealthResponse = {
  service: string
  status: string
  started_at: string
  database_path: string
  listen_addr: string
  timezone: string
  version: string
  schema_version: number
  rollup_algorithm_version: string
}

export type AgentMonitorStatus = {
  key: string
  label: string
  status: string
  detail: string
  last_seen: string | null
  last_error: string | null
  consecutive_failures: number
  restart_count: number
}

export type RecentTrackedItem = {
  key: string
  label: string
}

export type AgentSettingsResponse = {
  autostart_enabled: boolean
  tray_enabled: boolean
  web_ui_url: string
  launch_command: string
  idle_threshold_secs: number
  poll_interval_millis: number
  health_reminder_enabled: boolean
  health_reminder_threshold_secs: number
  health_reminder_work_start: string | null
  health_reminder_work_end: string | null
  health_reminder_quiet_start: string | null
  health_reminder_quiet_end: string | null
  record_window_titles: boolean
  record_page_titles: boolean
  ignored_apps: string[]
  ignored_domains: string[]
  recent_apps: RecentTrackedItem[]
  recent_domains: RecentTrackedItem[]
  monitors: AgentMonitorStatus[]
  tracking_paused: boolean
  paused_since: string | null
  pause_until: string | null
  retention_days: number | null
  database_size_bytes: number
  earliest_recorded_date: string | null
  last_backup_at: string | null
  version: string
  schema_version: number
  active_rollup_status: ActiveRollupStatus
}

export type PauseTrackingRequest = {
  duration_secs?: number
  until?: string
}

export type TrackingStateResponse = {
  tracking_paused: boolean
  paused_since: string | null
  pause_until: string | null
}

export type UpdateRetentionRequest = {
  retention_days: number | null
}

export type DeleteDataRequest = {
  from?: string
  to?: string
  all: boolean
}

export type UpdateAutostartRequest = {
  enabled: boolean
}

export type UpdateAutostartResponse = {
  autostart_enabled: boolean
}

export type UpdateAgentConfigRequest = {
  idle_threshold_secs: number
  poll_interval_millis: number
  health_reminder_enabled: boolean
  health_reminder_threshold_secs: number
  health_reminder_work_start?: string
  health_reminder_work_end?: string
  health_reminder_quiet_start?: string
  health_reminder_quiet_end?: string
  record_window_titles: boolean
  record_page_titles: boolean
  ignored_apps: string[]
  ignored_domains: string[]
}

export type UpdateAgentConfigResponse = {
  saved: boolean
  requires_restart: boolean
}

export type KeyedDurationEntry = {
  key: string
  label: string
  seconds: number
}

export type DaySummary = {
  date: string
  focus_seconds: number
  active_seconds: number
  browser_seconds: number
  switch_count: number
  active_app_seconds: number
  active_browser_seconds: number
  active_switch_count: number
  top_app: KeyedDurationEntry | null
  top_domain: KeyedDurationEntry | null
}

export type MonthCalendarResponse = {
  month: string
  timezone: string
  days: DaySummary[]
  active_rollup_status: ActiveRollupStatus
}

export type PeriodStat = {
  focus_seconds: number
  active_seconds: number
  foreground_seconds: number
  active_foreground_seconds: number
}

export type PeriodSummaryResponse = {
  date: string
  timezone: string
  today: PeriodStat
  week: PeriodStat
  month: PeriodStat
  active_rollup_status: ActiveRollupStatus
}

export type TrendPeriod = 'week' | 'month'

export type AppUsageTrendSeries = {
  key: string
  label: string
  total_seconds: number
  daily_seconds: number[]
  active_total_seconds: number
  active_daily_seconds: number[]
}

export type AppUsageTrendResponse = {
  period: TrendPeriod
  start_date: string
  end_date: string
  timezone: string
  days: string[]
  series: AppUsageTrendSeries[]
  active_rollup_status: ActiveRollupStatus
}

export type DebugEvent = {
  id: number
  kind: string
  payload_json: string
  observed_at: string
}

export type BrowserEventPayload = {
  domain: string
  page_title: string | null
  browser_window_id: number
  tab_id: number
  observed_at: string | null
}

export type BrowserEventAck = {
  accepted: boolean
  reason: string | null
}

export type ApiEnvelope<T> = {
  ok: boolean
  data: T | null
  error: {
    code: string
    message: string
  } | null
}
