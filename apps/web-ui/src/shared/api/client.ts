import type {
  AgentSettingsResponse,
  ApiEnvelope,
  AppUsageTrendResponse,
  DeleteDataRequest,
  DurationStat,
  FocusStats,
  HealthResponse,
  MonthCalendarResponse,
  PeriodSummaryResponse,
  PauseTrackingRequest,
  TrackingStateResponse,
  TimelineDayResponse,
  TrendPeriod,
  UpdateAgentConfigRequest,
  UpdateAgentConfigResponse,
  UpdateAutostartRequest,
  UpdateAutostartResponse,
} from './types'

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  fallbackError: string
  signal?: AbortSignal
}

/** Resolves the agent API base URL.
 *  - In production, the frontend is served by the agent itself.
 *  - During Vite dev/preview, API calls go to the local agent default port.
 *  - VITE_API_BASE_URL provides a manual override.
 */
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  (isLocalDevServer() ? 'http://127.0.0.1:46215' : window.location.origin)

function isLocalDevServer() {
  return (
    typeof window !== 'undefined' &&
    ['127.0.0.1', 'localhost'].includes(window.location.hostname) &&
    ['4173', '5173'].includes(window.location.port)
  )
}

export async function request<T>(
  path: string,
  options?: Partial<RequestOptions>,
): Promise<T> {
  const requestOptions: RequestOptions = {
    method: 'GET',
    fallbackError: '本地服务响应异常',
    ...options,
  }
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: requestOptions.method,
      headers:
        requestOptions.body === undefined
          ? undefined
          : {
            'Content-Type': 'application/json',
          },
      body:
        requestOptions.body === undefined
          ? undefined
          : JSON.stringify(requestOptions.body),
      signal: requestOptions.signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new Error(
      `无法连接本地服务 ${API_BASE_URL}，请确认 timeline 已启动并已允许跨域访问。`,
    )
  }

  const payload = await readApiEnvelope<T>(response)

  if (!response.ok || !payload.ok || payload.data === null) {
    throw new Error(payload.error?.message ?? requestOptions.fallbackError)
  }

  return payload.data
}

export async function readApiEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    const payload = await response.json()
    if (isApiEnvelope<T>(payload)) {
      return payload
    }
  } catch {
    // Fall through to a normalized envelope below.
  }

  return {
    ok: false,
    data: null,
    error: {
      code: 'invalid_response',
      message: `本地服务返回了无法解析的响应（HTTP ${response.status}）`,
    },
  }
}

function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as { ok?: unknown; data?: unknown; error?: unknown }
  return typeof candidate.ok === 'boolean' && 'data' in candidate && 'error' in candidate
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function getTimeline(date?: string, signal?: AbortSignal) {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  return request<TimelineDayResponse>(`/api/timeline/day${query}`, { signal })
}

export function getHealth(signal?: AbortSignal) {
  return request<HealthResponse>('/health', { signal })
}

export function getAppStats(date: string, signal?: AbortSignal) {
  return request<DurationStat[]>(`/api/stats/apps?date=${date}`, { signal })
}

export function getAppUsageTrend(
  date: string,
  period: TrendPeriod,
  limit = 6,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    date,
    period,
    limit: String(limit),
  })
  return request<AppUsageTrendResponse>(`/api/stats/apps/trend?${query}`, { signal })
}

export function getDomainStats(date: string, signal?: AbortSignal) {
  return request<DurationStat[]>(`/api/stats/domains?date=${date}`, { signal })
}

export function getFocusStats(date: string, signal?: AbortSignal) {
  return request<FocusStats>(`/api/stats/focus?date=${date}`, { signal })
}

export function getAgentSettings(signal?: AbortSignal) {
  return request<AgentSettingsResponse>('/api/settings', { signal }).then((raw) => ({
    ...raw,
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
    health_reminder_work_start:
      typeof raw.health_reminder_work_start === 'string' ? raw.health_reminder_work_start : null,
    health_reminder_work_end:
      typeof raw.health_reminder_work_end === 'string' ? raw.health_reminder_work_end : null,
    health_reminder_quiet_start:
      typeof raw.health_reminder_quiet_start === 'string' ? raw.health_reminder_quiet_start : null,
    health_reminder_quiet_end:
      typeof raw.health_reminder_quiet_end === 'string' ? raw.health_reminder_quiet_end : null,
    record_window_titles:
      typeof raw.record_window_titles === 'boolean' ? raw.record_window_titles : true,
    record_page_titles:
      typeof raw.record_page_titles === 'boolean' ? raw.record_page_titles : false,
    ignored_apps: Array.isArray(raw.ignored_apps) ? raw.ignored_apps : [],
    ignored_domains: Array.isArray(raw.ignored_domains) ? raw.ignored_domains : [],
    recent_apps: Array.isArray(raw.recent_apps) ? raw.recent_apps : [],
    recent_domains: Array.isArray(raw.recent_domains) ? raw.recent_domains : [],
    tracking_paused: Boolean(raw.tracking_paused),
    paused_since: raw.paused_since ?? null,
    pause_until: raw.pause_until ?? null,
    retention_days: typeof raw.retention_days === 'number' ? raw.retention_days : null,
    database_size_bytes:
      typeof raw.database_size_bytes === 'number' ? raw.database_size_bytes : 0,
    earliest_recorded_date: raw.earliest_recorded_date ?? null,
    last_backup_at: typeof raw.last_backup_at === 'string' ? raw.last_backup_at : null,
    version: raw.version ?? '未知',
    schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : 0,
    active_rollup_status: raw.active_rollup_status ?? {
      status: 'pending',
      completed_days: 0,
      total_days: 0,
      next_date: null,
      last_error: null,
      updated_at: null,
    },
  }))
}

export async function updateAutostart(payload: UpdateAutostartRequest) {
  return request<UpdateAutostartResponse>('/api/settings/autostart', {
    method: 'POST',
    body: payload,
    fallbackError: '更新开机自启动设置失败',
  })
}

export async function updateAgentConfig(payload: UpdateAgentConfigRequest) {
  return request<UpdateAgentConfigResponse>('/api/settings/config', {
    method: 'POST',
    body: payload,
    fallbackError: '更新本地配置失败',
  })
}

export function pauseTracking(payload: PauseTrackingRequest) {
  return request<TrackingStateResponse>('/api/tracking/pause', {
    method: 'POST',
    body: payload,
    fallbackError: '暂停采集失败',
  })
}

export function resumeTracking() {
  return request<TrackingStateResponse>('/api/tracking/resume', {
    method: 'POST',
    body: {},
    fallbackError: '恢复采集失败',
  })
}

export function updateRetention(retentionDays: number | null) {
  return request<{ retention_days: number | null }>('/api/data/retention', {
    method: 'POST',
    body: { retention_days: retentionDays },
    fallbackError: '更新数据保留策略失败',
  })
}

export function deleteData(payload: DeleteDataRequest) {
  return request<{ deleted: boolean }>('/api/data/delete', {
    method: 'POST',
    body: payload,
    fallbackError: '删除数据失败',
  })
}

export function getMonthCalendar(month: string, signal?: AbortSignal) {
  return request<MonthCalendarResponse>(`/api/calendar/month?month=${month}`, { signal })
}

export function getPeriodSummary(date?: string, signal?: AbortSignal) {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  return request<PeriodSummaryResponse>(`/api/stats/summary${query}`, { signal })
}
