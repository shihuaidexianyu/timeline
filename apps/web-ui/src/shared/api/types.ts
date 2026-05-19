export type PresenceState = 'active' | 'idle' | 'locked'

export type FocusSegment = {
  id: number
  started_at: string
  ended_at: string | null
  app: {
    process_name: string
    display_name: string
    exe_path: string | null
    window_title: string | null
    is_browser: boolean
  }
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
}

export type FocusStats = {
  total_focus_seconds: number
  total_active_seconds: number
  switch_count: number
  longest_focus_block_seconds: number
  average_focus_block_seconds: number
}

export type AgentMonitorStatus = {
  key: string
  label: string
  status: string
  detail: string
  last_seen: string | null
}

export type AgentSettingsResponse = {
  app_version: string
  autostart_enabled: boolean
  tray_enabled: boolean
  web_ui_url: string
  launch_command: string
  idle_threshold_secs: number
  poll_interval_millis: number
  health_reminder_enabled: boolean
  health_reminder_threshold_secs: number
  record_window_titles: boolean
  record_page_titles: boolean
  ignored_apps: string[]
  ignored_domains: string[]
  monitors: AgentMonitorStatus[]
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
  record_window_titles: boolean
  record_page_titles: boolean
  ignored_apps: string[]
  ignored_domains: string[]
}

export type UpdateAgentConfigResponse = {
  saved: boolean
  requires_restart: boolean
}

export type AppUpdateInfo = {
  current_version: string
  latest_version: string
  has_update: boolean
  release_name: string | null
  release_url: string
  published_at: string | null
  asset_name: string
}

export type InstallUpdateResponse = {
  started: boolean
  target_version: string
  release_url: string
  asset_name: string
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
  top_app: KeyedDurationEntry | null
  top_domain: KeyedDurationEntry | null
}

export type MonthCalendarResponse = {
  month: string
  timezone: string
  days: DaySummary[]
}

export type PeriodStat = {
  focus_seconds: number
  active_seconds: number
}

export type PeriodSummaryResponse = {
  date: string
  timezone: string
  today: PeriodStat
  week: PeriodStat
  month: PeriodStat
}

export type ApiEnvelope<T> = {
  ok: boolean
  data: T | null
  error: {
    code: string
    message: string
  } | null
}
