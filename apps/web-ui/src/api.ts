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
  autostart_enabled: boolean
  tray_enabled: boolean
  web_ui_url: string
  launch_command: string
  monitors: AgentMonitorStatus[]
}

export type UpdateAutostartRequest = {
  enabled: boolean
}

export type UpdateAutostartResponse = {
  autostart_enabled: boolean
}

type ApiEnvelope<T> = {
  ok: boolean
  data: T | null
  error: {
    code: string
    message: string
  } | null
}

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:46215'

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

export function getTimeline(date: string) {
  return request<TimelineDayResponse>(`/api/timeline/day?date=${date}`)
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
  return request<AgentSettingsResponse>('/api/settings')
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
