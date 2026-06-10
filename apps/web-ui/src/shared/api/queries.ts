import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  getAgentSettings,
  getMonthCalendar,
  getPeriodSummary,
  getTimeline,
  updateAgentConfig,
  updateAutostart,
} from './client'
import type {
  AgentSettingsResponse,
  UpdateAgentConfigRequest,
  UpdateAutostartRequest,
} from './types'

export const apiQueryKeys = {
  timelineDay: (date: string | null | undefined) =>
    ['timeline-day', date ?? 'current'] as const,
  periodSummary: (date: string | null | undefined) =>
    ['period-summary', date ?? 'current'] as const,
  monthCalendar: (month: string | null | undefined) =>
    ['month-calendar', month ?? 'none'] as const,
  agentSettings: () => ['agent-settings'] as const,
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

export function useAgentSettingsQuery() {
  return useQuery({
    queryKey: apiQueryKeys.agentSettings(),
    queryFn: ({ signal }) => getAgentSettings(signal),
    placeholderData: keepPreviousData,
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
