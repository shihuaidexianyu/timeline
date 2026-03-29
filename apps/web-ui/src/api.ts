/* Centralized browser-side API client for the local timeline agent. */

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

type ApiEnvelope<T> = {
  ok: boolean
  data: T | null
  error: {
    code: string
    message: string
  } | null
}

/** Resolves the agent API base URL.
 *  - In production (self-hosted mode), the frontend is served by the agent itself, so
 *    `window.location.origin` points to the correct address.
 *  - During development, Vite runs on ports 4173 (preview) or 5173 (dev), so we
 *    redirect API calls to the agent's default port 46215.
 *  - The `VITE_API_BASE_URL` env var provides a manual override for either case.
 */
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  (isLocalDevServer() ? 'http://127.0.0.1:46215' : window.location.origin)

/** Returns true when running inside the Vite dev/preview server (ports 4173/5173). */
function isLocalDevServer() {
  return (
    typeof window !== 'undefined' &&
    ['127.0.0.1', 'localhost'].includes(window.location.hostname) &&
    ['4173', '5173'].includes(window.location.port)
  )
}

async function request<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`)
  } catch {
    throw new Error(
      `无法连接本地服务 ${API_BASE_URL}，请确认 timeline-agent 已启动并已允许跨域访问。`,
    )
  }

  const payload = (await response.json()) as ApiEnvelope<T>

  if (!response.ok || !payload.ok || payload.data === null) {
    throw new Error(payload.error?.message ?? '本地服务响应异常')
  }

  return payload.data
}

export function getTimeline(date?: string) {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  return request<TimelineDayResponse>(`/api/timeline/day${query}`)
}

export function getAppStats(date: string) {
  return request<DurationStat[]>(`/api/stats/apps?date=${date}`)
}

export function getDomainStats(date: string) {
  return request<DurationStat[]>(`/api/stats/domains?date=${date}`)
}

export function getFocusStats(date: string) {
  return request<FocusStats>(`/api/stats/focus?date=${date}`)
}

export function getAgentSettings() {
  return request<AgentSettingsResponse>('/api/settings').then((raw) => ({
    ...raw,
    app_version: typeof raw.app_version === 'string' ? raw.app_version : '0.0.0',
    idle_threshold_secs:
      typeof raw.idle_threshold_secs === 'number' ? raw.idle_threshold_secs : 300,
    poll_interval_millis:
      typeof raw.poll_interval_millis === 'number' ? raw.poll_interval_millis : 1000,
    health_reminder_enabled:
      typeof raw.health_reminder_enabled === 'boolean' ? raw.health_reminder_enabled : true,
    health_reminder_threshold_secs:
      typeof raw.health_reminder_threshold_secs === 'number'
        ? raw.health_reminder_threshold_secs
        : 3000,
    record_window_titles:
      typeof raw.record_window_titles === 'boolean' ? raw.record_window_titles : true,
    record_page_titles:
      typeof raw.record_page_titles === 'boolean' ? raw.record_page_titles : true,
    ignored_apps: Array.isArray(raw.ignored_apps) ? raw.ignored_apps : [],
    ignored_domains: Array.isArray(raw.ignored_domains) ? raw.ignored_domains : [],
  }))
}

export function getAppUpdateInfo() {
  return request<AppUpdateInfo>('/api/update/check')
}

export async function updateAutostart(payload: UpdateAutostartRequest) {
  const response = await fetch(`${API_BASE_URL}/api/settings/autostart`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const result = (await response.json()) as ApiEnvelope<UpdateAutostartResponse>
  if (!response.ok || !result.ok || result.data === null) {
    throw new Error(result.error?.message ?? '更新开机自启动设置失败')
  }

  return result.data
}

export async function updateAgentConfig(payload: UpdateAgentConfigRequest) {
  const response = await fetch(`${API_BASE_URL}/api/settings/config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const result = (await response.json()) as ApiEnvelope<UpdateAgentConfigResponse>
  if (!response.ok || !result.ok || result.data === null) {
    throw new Error(result.error?.message ?? '更新本地配置失败')
  }

  return result.data
}

export async function installLatestUpdate() {
  const response = await fetch(`${API_BASE_URL}/api/update/install`, {
    method: 'POST',
  })

  const result = (await response.json()) as ApiEnvelope<InstallUpdateResponse>
  if (!response.ok || !result.ok || result.data === null) {
    throw new Error(result.error?.message ?? '启动在线升级失败')
  }

  return result.data
}

// ── Month calendar and period summary types ──

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

export function getMonthCalendar(month: string) {
  return request<MonthCalendarResponse>(`/api/calendar/month?month=${month}`)
}

export function getPeriodSummary(date?: string) {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  return request<PeriodSummaryResponse>(`/api/stats/summary${query}`)
}
