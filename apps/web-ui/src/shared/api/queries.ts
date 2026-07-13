import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  getAgentSettings,
  deleteData,
  getHealth,
  getAppUsageTrend,
  getMonthCalendar,
  getPeriodSummary,
  getTimeline,
  pauseTracking,
  resumeTracking,
  updateAgentConfig,
  updateAutostart,
  updateRetention,
} from './client'
import type {
  AgentSettingsResponse,
  DeleteDataRequest,
  PauseTrackingRequest,
  TrendPeriod,
  UpdateAgentConfigRequest,
  UpdateAutostartRequest,
} from './types'

export const apiQueryKeys = {
  timelineDay: (date: string | null | undefined) =>
    ['timeline-day', date ?? 'current'] as const,
  periodSummary: (date: string | null | undefined) =>
    ['period-summary', date ?? 'current'] as const,
  appUsageTrend: (
    date: string | null | undefined,
    period: TrendPeriod,
    limit: number,
  ) => ['app-usage-trend', date ?? 'none', period, limit] as const,
  monthCalendar: (month: string | null | undefined) =>
    ['month-calendar', month ?? 'none'] as const,
  agentSettings: () => ['agent-settings'] as const,
  health: () => ['health'] as const,
}

type QueryHookOptions = {
  enabled?: boolean
  refetchInterval?: number | false
  refetchOnWindowFocus?: boolean
}

export function useTimelineDayQuery(
  date: string | null | undefined,
  options?: QueryHookOptions,
) {
  return useQuery({
    queryKey: apiQueryKeys.timelineDay(date),
    queryFn: ({ signal }) => getTimeline(date ?? undefined, signal),
    placeholderData: keepPreviousData,
    ...options,
  })
}

export function usePeriodSummaryQuery(
  date: string | null | undefined,
  options?: QueryHookOptions,
) {
  return useQuery({
    queryKey: apiQueryKeys.periodSummary(date),
    queryFn: ({ signal }) => getPeriodSummary(date ?? undefined, signal),
    placeholderData: keepPreviousData,
    ...options,
  })
}

export function useAppUsageTrendQuery(
  date: string | null | undefined,
  period: TrendPeriod,
  limit = 6,
  options?: QueryHookOptions,
) {
  const { enabled, ...queryOptions } = options ?? {}

  return useQuery({
    queryKey: apiQueryKeys.appUsageTrend(date, period, limit),
    queryFn: ({ signal }) => getAppUsageTrend(date ?? '', period, limit, signal),
    enabled: Boolean(date) && (enabled ?? true),
    placeholderData: keepPreviousData,
    ...queryOptions,
  })
}

export function useMonthCalendarQuery(
  month: string | null | undefined,
  options?: QueryHookOptions,
) {
  return useQuery({
    queryKey: apiQueryKeys.monthCalendar(month),
    queryFn: ({ signal }) => getMonthCalendar(month ?? '', signal),
    enabled: Boolean(month),
    placeholderData: keepPreviousData,
    ...options,
  })
}

export function useAgentSettingsQuery(options?: Pick<QueryHookOptions, 'enabled'>) {
  return useQuery({
    queryKey: apiQueryKeys.agentSettings(),
    queryFn: ({ signal }) => getAgentSettings(signal),
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
    ...options,
  })
}

export function useHealthQuery() {
  return useQuery({
    queryKey: apiQueryKeys.health(),
    queryFn: ({ signal }) => getHealth(signal),
    refetchInterval: 10_000,
  })
}

export function useUpdateAgentConfigMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: UpdateAgentConfigRequest) => updateAgentConfig(payload),
    onSuccess: (result, payload) => {
      if (!result.saved) {
        return
      }

      queryClient.setQueryData<AgentSettingsResponse>(
        apiQueryKeys.agentSettings(),
        (current) =>
          current
            ? {
              ...current,
              idle_threshold_secs: payload.idle_threshold_secs,
              poll_interval_millis: payload.poll_interval_millis,
              health_reminder_enabled: payload.health_reminder_enabled,
              health_reminder_threshold_secs: payload.health_reminder_threshold_secs,
              health_reminder_work_start: normalizeOptionalTimeUpdate(
                payload.health_reminder_work_start,
                current.health_reminder_work_start,
              ),
              health_reminder_work_end: normalizeOptionalTimeUpdate(
                payload.health_reminder_work_end,
                current.health_reminder_work_end,
              ),
              health_reminder_quiet_start: normalizeOptionalTimeUpdate(
                payload.health_reminder_quiet_start,
                current.health_reminder_quiet_start,
              ),
              health_reminder_quiet_end: normalizeOptionalTimeUpdate(
                payload.health_reminder_quiet_end,
                current.health_reminder_quiet_end,
              ),
              record_window_titles: payload.record_window_titles,
              record_page_titles: payload.record_page_titles,
              ignored_apps: payload.ignored_apps,
              ignored_domains: payload.ignored_domains,
            }
            : current,
      )
    },
  })
}

export function useUpdateAutostartMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: UpdateAutostartRequest) => updateAutostart(payload),
    onSuccess: (result) => {
      queryClient.setQueryData<AgentSettingsResponse>(
        apiQueryKeys.agentSettings(),
        (current) =>
          current
            ? {
              ...current,
              autostart_enabled: result.autostart_enabled,
            }
            : current,
      )
    },
  })
}

function normalizeOptionalTimeUpdate(value: string | undefined, current: string | null) {
  if (value === undefined) return current
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function usePauseTrackingMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: PauseTrackingRequest) => pauseTracking(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.agentSettings() })
      void queryClient.invalidateQueries({ queryKey: ['timeline-day'] })
    },
  })
}

export function useResumeTrackingMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: resumeTracking,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.agentSettings() })
      void queryClient.invalidateQueries({ queryKey: ['timeline-day'] })
    },
  })
}

export function useRetentionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateRetention,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.agentSettings() })
    },
  })
}

export function useDeleteDataMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: DeleteDataRequest) => deleteData(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries()
    },
  })
}
