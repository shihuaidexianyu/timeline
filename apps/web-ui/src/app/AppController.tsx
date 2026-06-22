import { useEffect, useMemo, useState } from 'react'
import { AppShell } from './AppShell'
import { useHashQueryParam, useHashRoute } from './page-route'
import { useSelectedDateState } from './use-selected-date-state'
import {
  useAgentSettingsQuery,
  useAppStatsQuery,
  useAppUsageTrendQuery,
  useMonthCalendarQuery,
  usePeriodSummaryQuery,
  useTimelineDayQuery,
  useUpdateAgentConfigMutation,
  useUpdateAutostartMutation,
} from '../shared/api'
import {
  buildDashboardModel,
  durationStatsToDonutSlices,
  type DashboardFilter,
} from '../lib/chart-model'
import {
  buildWeekSeries,
  isValidDateKey,
  monthFromDate,
} from '../lib/dashboard-helpers'
import { useTheme } from '../hooks/use-theme'
import { SettingsPage } from '../pages/settings-page'
import { StatsPage } from '../pages/stats-page'
import { UsagePage } from '../pages/usage-page'
import type { UsageMetric } from '../shared/api'
import type { AppTrendView } from '../pages/usage-page'

export function AppController() {
  const { theme, setTheme } = useTheme()
  const [page, setPage] = useHashRoute()
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [urlMetric, setUrlMetric] = useHashQueryParam('metric')
  const appUsageMetric: UsageMetric =
    urlMetric === 'focus' || urlMetric === 'visible_window' ? urlMetric : 'visible_window'
  const setAppUsageMetric = (value: UsageMetric) => setUrlMetric(value)
  const [appTrendView, setAppTrendView] = useState<AppTrendView>('week')

  const timelineQuery = useTimelineDayQuery(null)
  const timeline = timelineQuery.data ?? null
  const periodQuery = usePeriodSummaryQuery(timeline?.date ?? null)
  const settingsQuery = useAgentSettingsQuery({
    enabled: page === 'settings',
  })
  const agentToday = periodQuery.data?.date ?? null
  const agentTimezone = timeline?.timezone ?? null
  const dateState = useSelectedDateState({ agentToday, agentTimezone })
  const selectedTimelineQuery = useTimelineDayQuery(dateState.selectedDate, {
    enabled:
      dateState.selectedDate !== null &&
      dateState.selectedDate !== timeline?.date,
  })
  const selectedPeriodQuery = usePeriodSummaryQuery(dateState.selectedDate, {
    enabled:
      dateState.selectedDate !== null &&
      dateState.selectedDate !== (periodQuery.data?.date ?? timeline?.date),
  })
  const selectedTimeline = dateState.selectedDate
    ? selectedTimelineQuery.data ??
      (dateState.selectedDate === timeline?.date ? timeline : undefined)
    : timeline
  const selectedPeriodSummary = dateState.selectedDate
    ? selectedPeriodQuery.data ??
      (dateState.selectedDate === periodQuery.data?.date ? periodQuery.data : undefined)
    : periodQuery.data
  const calendarQuery = useMonthCalendarQuery(dateState.calendarMonth, {
    enabled: page === 'stats',
  })
  const appTrendDate = dateState.selectedDate ?? timeline?.date ?? null
  const appTrendQuery = useAppUsageTrendQuery(
    appTrendDate,
    appTrendView,
    appUsageMetric,
    6,
    {
      enabled: page === 'usage' && appTrendDate !== null,
    },
  )
  const appStatsQuery = useAppStatsQuery(appTrendDate, appUsageMetric, {
    enabled: (page === 'stats' || page === 'usage') && appTrendDate !== null,
  })
  const updateConfigMutation = useUpdateAgentConfigMutation()
  const updateAutostartMutation = useUpdateAutostartMutation()

  useEffect(() => {
    if (!timeline || dateState.selectedDate !== null) {
      return
    }

    if (!periodQuery.data && !periodQuery.isError) {
      return
    }

    dateState.initializeDate(timeline.date)
  }, [
    dateState,
    periodQuery.data,
    periodQuery.isError,
    timeline,
  ])

  const lastTimelineDataUpdatedAt = Math.max(
    timelineQuery.dataUpdatedAt,
    selectedTimelineQuery.dataUpdatedAt,
  )
  const lastUpdatedAt = useMemo(
    () =>
      lastTimelineDataUpdatedAt > 0
        ? new Date(lastTimelineDataUpdatedAt).toLocaleTimeString()
        : null,
    [lastTimelineDataUpdatedAt],
  )

  const dashboard = useMemo(
    () => (selectedTimeline ? buildDashboardModel(selectedTimeline, false) : null),
    [selectedTimeline],
  )
  const appStatSlices = useMemo(
    () => durationStatsToDonutSlices(appStatsQuery.data ?? [], 'app'),
    [appStatsQuery.data],
  )
  const appStatTotalSeconds = useMemo(
    () => (appStatsQuery.data ?? []).reduce((sum, item) => sum + item.seconds, 0),
    [appStatsQuery.data],
  )
  const resolvedSelectedDate =
    dateState.selectedDate ?? selectedTimeline?.date ?? timeline?.date ?? '--'
  const resolvedTimezone =
    selectedTimeline?.timezone ?? timeline?.timezone ?? agentTimezone ?? '--'
  const weekBars = useMemo(
    () =>
      isValidDateKey(resolvedSelectedDate)
        ? buildWeekSeries(calendarQuery.data?.days ?? [], resolvedSelectedDate)
        : [],
    [calendarQuery.data?.days, resolvedSelectedDate],
  )
  const serviceError = firstErrorMessage([
    timelineQuery.error,
    selectedTimelineQuery.error,
    periodQuery.error,
    selectedPeriodQuery.error,
    settingsQuery.error,
  ])
  const hasDashboard = dashboard !== null
  const isInitialLoading =
    !hasDashboard &&
    (selectedTimelineQuery.isPending || timelineQuery.isPending)
  const shouldRenderPage = hasDashboard || (isInitialLoading && !serviceError)

  function selectDate(nextDate: string) {
    dateState.selectDate(nextDate)
    setAppFilter(null)
    setDomainFilter(null)
  }

  function selectCalendarMonth(nextMonth: string) {
    dateState.selectCalendarMonth(nextMonth)
    setDomainFilter(null)
  }

  return (
    <AppShell
      page={page}
      selectedDate={resolvedSelectedDate}
      timezone={resolvedTimezone}
      serviceError={serviceError}
      lastUpdatedAt={lastUpdatedAt}
      onPageChange={setPage}
    >
      {serviceError && !hasDashboard && !shouldRenderPage ? (
        <ErrorState error={serviceError} />
      ) : null}
      {serviceError && hasDashboard ? <InlineErrorState error={serviceError} /> : null}

      {shouldRenderPage ? (
        <>
          {page === 'stats' ? (
            <StatsPage
              dashboard={dashboard}
              loading={!hasDashboard}
              appFilter={appFilter}
              domainFilter={domainFilter}
              setAppFilter={setAppFilter}
              setDomainFilter={setDomainFilter}
              periodSummary={selectedPeriodSummary ?? null}
              appUsageMetric={appUsageMetric}
              appStats={appStatSlices}
              appStatsTotalSeconds={appStatTotalSeconds}
              calendarDays={calendarQuery.data?.days ?? []}
              calendarMonth={
                dateState.calendarMonth ?? monthFromDate(resolvedSelectedDate)
              }
              selectedDate={resolvedSelectedDate}
              agentToday={selectedPeriodSummary?.date ?? null}
              calendarError={errorToNullableMessage(calendarQuery.error)}
              weekBars={weekBars}
              isTimelineRefreshing={
                (timelineQuery.isFetching || selectedTimelineQuery.isFetching) &&
                hasDashboard
              }
              isPeriodRefreshing={
                selectedPeriodQuery.isFetching && Boolean(selectedPeriodSummary)
              }
              isAppStatsRefreshing={appStatsQuery.isFetching}
              isCalendarRefreshing={calendarQuery.isFetching}
              appStatsError={errorToNullableMessage(appStatsQuery.error)}
              onRetryAppStats={() => { void appStatsQuery.refetch() }}
              onRetryCalendar={() => { void calendarQuery.refetch() }}
              onCalendarMonthChange={selectCalendarMonth}
              onSelectDate={selectDate}
            />
          ) : null}

          {page === 'usage' ? (
            <UsagePage
              loading={!hasDashboard}
              selectedDate={resolvedSelectedDate}
              appUsageMetric={appUsageMetric}
              setAppUsageMetric={setAppUsageMetric}
              appTrendView={appTrendView}
              setAppTrendView={setAppTrendView}
              appTrend={appTrendQuery.data ?? null}
              appTrendError={errorToNullableMessage(appTrendQuery.error)}
              onRetryTrend={() => { void appTrendQuery.refetch() }}
              isAppTrendRefreshing={appTrendQuery.isFetching}
            />
          ) : null}

          {page === 'settings' ? (
            <SettingsPage
              agentSettings={settingsQuery.data ?? null}
              loading={!settingsQuery.data && settingsQuery.isPending}
              error={serviceError}
              settingsError={settingsError ?? errorToNullableMessage(settingsQuery.error)}
              settingsNotice={settingsNotice}
              lastUpdatedAt={lastUpdatedAt}
              selectedDate={resolvedSelectedDate}
              timezone={resolvedTimezone}
              savingAutostart={updateAutostartMutation.isPending}
              savingConfig={updateConfigMutation.isPending}
              isSettingsRefreshing={settingsQuery.isFetching && Boolean(settingsQuery.data)}
              theme={theme}
              onChangeTheme={setTheme}
              onToggleAutostart={async (enabled) => {
                setSettingsError(null)
                setSettingsNotice(null)

                try {
                  await updateAutostartMutation.mutateAsync({ enabled })
                } catch (toggleError) {
                  setSettingsError(
                    errorToMessage(toggleError, '更新开机自启动设置失败'),
                  )
                }
              }}
              onUpdateConfig={async (payload) => {
                setSettingsError(null)
                setSettingsNotice(null)

                try {
                  const result = await updateConfigMutation.mutateAsync(payload)
                  if (result.saved) {
                    setSettingsNotice(
                      result.requires_restart
                        ? '设置已保存，重启 timeline 后生效。'
                        : null,
                    )
                  }
                } catch (updateError) {
                  setSettingsError(errorToMessage(updateError, '更新本地配置失败'))
                }
              }}
            />
          ) : null}
        </>
      ) : null}
    </AppShell>
  )
}

function ErrorState(props: { error: string }) {
  return <div className="state-card error-card">{props.error}</div>
}

function InlineErrorState(props: { error: string }) {
  return <div className="inline-error-banner">{props.error}</div>
}

function firstErrorMessage(errors: unknown[]) {
  for (const error of errors) {
    const message = errorToNullableMessage(error)
    if (message) {
      return message
    }
  }

  return null
}

function errorToNullableMessage(error: unknown) {
  return error ? errorToMessage(error, '本地服务响应异常') : null
}

function errorToMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
