import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './AppShell'
import { dateFromHash, replaceHashDate, setHashDate, useHashRoute } from './page-route'
import { useSelectedDateState } from './use-selected-date-state'
import {
  useAgentSettingsQuery,
  useDeleteDataMutation,
  useHealthQuery,
  useAppUsageTrendQuery,
  useMonthCalendarQuery,
  usePauseTrackingMutation,
  usePeriodSummaryQuery,
  useTimelineDayQuery,
  useResumeTrackingMutation,
  useRetentionMutation,
  useUpdateAgentConfigMutation,
  useUpdateAutostartMutation,
} from '../shared/api'
import {
  buildDashboardModel,
  type DashboardFilter,
} from '../lib/chart-model'
import {
  buildWeekSeries,
  isValidDateKey,
  monthFromDate,
} from '../lib/dashboard-helpers'
import { useTheme } from '../hooks/use-theme'
import type { DeleteDataRequest, TrendPeriod } from '../shared/api'
import type { TimelineSegmentKind } from '../features/timeline/timeline-selectors'

const StatsPage = lazy(() =>
  import('../pages/stats-page').then((module) => ({ default: module.StatsPage })),
)
const TimelinePage = lazy(() =>
  import('../pages/timeline-page').then((module) => ({ default: module.TimelinePage })),
)
const SettingsPage = lazy(() =>
  import('../pages/settings-page').then((module) => ({ default: module.SettingsPage })),
)

const PRIVACY_INTRO_STORAGE_KEY = 'timeline-privacy-intro-v1'

function shouldShowPrivacyIntro() {
  try {
    return window.localStorage.getItem(PRIVACY_INTRO_STORAGE_KEY) !== 'seen'
  } catch {
    return true
  }
}

function rememberPrivacyIntro() {
  try {
    window.localStorage.setItem(PRIVACY_INTRO_STORAGE_KEY, 'seen')
  } catch {
    // A blocked storage backend should not prevent the user from dismissing the notice.
  }
}

export function AppController() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const [page, setPage, routeHash] = useHashRoute()
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [timelineActiveOnly, setTimelineActiveOnly] = useState(false)
  const [timelineSearchQuery, setTimelineSearchQuery] = useState('')
  const [timelineSearchFocusRequest, setTimelineSearchFocusRequest] = useState(0)
  const [showPrivacyIntro, setShowPrivacyIntro] = useState(shouldShowPrivacyIntro)
  const [timelineSegmentKind, setTimelineSegmentKind] =
    useState<TimelineSegmentKind>('all')
  const [focusedSegmentId, setFocusedSegmentId] = useState<string | null>(null)
  const [appTrendPeriod, setAppTrendPeriod] = useState<TrendPeriod>('week')
  const positionedViewportDate = useRef<string | null>(null)

  const timelineQuery = useTimelineDayQuery(null, { refetchInterval: 10_000 })
  const timeline = timelineQuery.data ?? null
  const periodQuery = usePeriodSummaryQuery(timeline?.date ?? null, {
    refetchInterval: 10_000,
  })
  const settingsQuery = useAgentSettingsQuery({ enabled: page === 'settings' })
  const healthQuery = useHealthQuery()
  const agentToday = periodQuery.data?.date ?? null
  const previousAgentToday = useRef<string | null>(agentToday)
  const agentTimezone = timeline?.timezone ?? null
  const dateState = useSelectedDateState({
    agentToday,
    agentTimezone,
    initialDate: dateFromHash(routeHash),
  })
  const selectedTimelineQuery = useTimelineDayQuery(dateState.selectedDate, {
    enabled:
      dateState.selectedDate !== null &&
      dateState.selectedDate !== timeline?.date,
    refetchInterval:
      dateState.selectedDate !== null && dateState.selectedDate === agentToday
        ? 10_000
        : false,
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
  const calendarQuery = useMonthCalendarQuery(dateState.calendarMonth)
  const appTrendDate = dateState.selectedDate ?? timeline?.date ?? null
  const appTrendQuery = useAppUsageTrendQuery(appTrendDate, appTrendPeriod, 6, {
    enabled: page === 'stats' && appTrendDate !== null,
  })
  const updateConfigMutation = useUpdateAgentConfigMutation()
  const updateAutostartMutation = useUpdateAutostartMutation()
  const pauseTrackingMutation = usePauseTrackingMutation()
  const resumeTrackingMutation = useResumeTrackingMutation()
  const retentionMutation = useRetentionMutation()
  const deleteDataMutation = useDeleteDataMutation()

  useEffect(() => {
    if (!timeline || dateState.selectedDate !== null) {
      return
    }

    if (!periodQuery.data && !periodQuery.isError) {
      return
    }

    dateState.initializeDate(timeline.date)
    replaceHashDate(page, timeline.date)
  }, [
    dateState,
    periodQuery.data,
    periodQuery.isError,
    timeline,
    page,
  ])

  useEffect(() => {
    const routeDate = dateFromHash(routeHash)
    if (routeDate && routeDate !== dateState.selectedDate) {
      dateState.selectDate(routeDate)
    }
  }, [dateState, routeHash])

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
    () => (selectedTimeline ? buildDashboardModel(selectedTimeline, true, resolvedTheme) : null),
    [resolvedTheme, selectedTimeline],
  )
  const timelineDashboard = useMemo(
    () =>
      selectedTimeline
        ? buildDashboardModel(selectedTimeline, timelineActiveOnly, resolvedTheme)
        : null,
    [resolvedTheme, selectedTimeline, timelineActiveOnly],
  )

  useEffect(() => {
    const date = selectedTimeline?.date
    if (!date || positionedViewportDate.current === date || !dashboard) return
    positionedViewportDate.current = date
    if (date !== agentToday) {
      const first = dashboard.focusSegments[0]
      if (first) {
        dateState.setZoomHours(0.5)
        dateState.setViewStartHour(Math.max(0, first.startSec / 3600 - 0.05))
      }
    }
  }, [agentToday, dashboard, dateState, selectedTimeline?.date])

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
    healthQuery.error,
    timelineQuery.error,
    selectedTimelineQuery.error,
    periodQuery.error,
    selectedPeriodQuery.error,
  ])

  useEffect(() => {
    const previous = previousAgentToday.current
    if (
      agentToday &&
      previous &&
      previous !== agentToday &&
      dateState.selectedDate === previous
    ) {
      dateState.selectDate(agentToday)
      setHashDate(page, agentToday)
    }
    previousAgentToday.current = agentToday
  }, [agentToday, dateState, page])
  const hasDashboard = dashboard !== null
  const isInitialLoading =
    !hasDashboard &&
    (selectedTimelineQuery.isPending || timelineQuery.isPending)
  const shouldRenderPage = hasDashboard || (isInitialLoading && !serviceError)

  function selectDate(nextDate: string) {
    dateState.selectDate(nextDate)
    setHashDate(page, nextDate)
    setDomainFilter(null)
    setFocusedSegmentId(null)
  }

  function shiftDate(days: number) {
    if (!isValidDateKey(resolvedSelectedDate)) return
    const next = new Date(`${resolvedSelectedDate}T12:00:00`)
    next.setDate(next.getDate() + days)
    selectDate(next.toISOString().slice(0, 10))
  }

  function clearAllFilters() {
    setAppFilter(null)
    setDomainFilter(null)
    setTimelineActiveOnly(false)
    setTimelineSearchQuery('')
    setTimelineSegmentKind('all')
    setFocusedSegmentId(null)
  }

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const isEditing = target?.matches('input, textarea, select, [contenteditable="true"]')
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        shiftDate(-1)
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault()
        shiftDate(1)
      } else if (!isEditing && event.key.toLowerCase() === 't' && agentToday) {
        event.preventDefault()
        selectDate(agentToday)
      } else if (!isEditing && event.key === '/') {
        event.preventDefault()
        if (page !== 'timeline') setPage('timeline')
        setTimelineSearchFocusRequest((request) => request + 1)
      }
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  })

  function selectCalendarMonth(nextMonth: string) {
    dateState.selectCalendarMonth(nextMonth)
    setDomainFilter(null)
    setFocusedSegmentId(null)
  }

  return (
    <AppShell
      page={page}
      selectedDate={resolvedSelectedDate}
      timezone={resolvedTimezone}
      serviceError={serviceError}
      lastUpdatedAt={lastUpdatedAt}
      onPageChange={(nextPage) => {
        if (nextPage !== page) setFocusedSegmentId(null)
        setPage(nextPage)
      }}
      onPreviousDate={() => shiftDate(-1)}
      onNextDate={() => shiftDate(1)}
      onToday={() => agentToday && selectDate(agentToday)}
      onDateChange={selectDate}
      showPrivacyIntro={showPrivacyIntro}
      onDismissPrivacyIntro={() => {
        rememberPrivacyIntro()
        setShowPrivacyIntro(false)
      }}
      onOpenPrivacySettings={() => {
        rememberPrivacyIntro()
        setShowPrivacyIntro(false)
        setPage('settings')
      }}
    >
      {serviceError && !hasDashboard && !shouldRenderPage ? (
        <ErrorState error={serviceError} />
      ) : null}
      {serviceError && hasDashboard ? <InlineErrorState error={serviceError} /> : null}
      {selectedPeriodSummary?.active_rollup_status &&
      selectedPeriodSummary.active_rollup_status.status !== 'ready' ? (
        <div className="inline-info-banner">
          {selectedPeriodSummary.active_rollup_status.status === 'failed'
            ? '活跃统计升级失败，当前保留原始前台数据。'
            : `正在升级活跃统计（${selectedPeriodSummary.active_rollup_status.completed_days}/${selectedPeriodSummary.active_rollup_status.total_days} 天）`}
        </div>
      ) : null}
      {appFilter || domainFilter || timelineActiveOnly || timelineSearchQuery || timelineSegmentKind !== 'all' ? (
        <div className="filter-chip-bar" aria-label="当前筛选">
          {appFilter ? <button type="button" onClick={() => setAppFilter(null)}>应用：{appFilter.key} ×</button> : null}
          {domainFilter ? <button type="button" onClick={() => setDomainFilter(null)}>域名：{domainFilter.key} ×</button> : null}
          {timelineActiveOnly ? <button type="button" onClick={() => setTimelineActiveOnly(false)}>仅活跃 ×</button> : null}
          {timelineSearchQuery ? <button type="button" onClick={() => setTimelineSearchQuery('')}>搜索：{timelineSearchQuery} ×</button> : null}
          {timelineSegmentKind !== 'all' ? <button type="button" onClick={() => setTimelineSegmentKind('all')}>类型：{timelineSegmentKind === 'app' ? '应用' : '浏览器'} ×</button> : null}
          <button type="button" onClick={clearAllFilters}>清空全部</button>
        </div>
      ) : null}

      {shouldRenderPage ? (
        <Suspense fallback={<div className="state-card">正在加载页面…</div>}>
          {page === 'stats' ? (
            <StatsPage
              dashboard={dashboard}
              loading={!hasDashboard}
              resolvedTheme={resolvedTheme}
              appFilter={appFilter}
              domainFilter={domainFilter}
              setAppFilter={setAppFilter}
              setDomainFilter={setDomainFilter}
              periodSummary={selectedPeriodSummary ?? null}
              appTrend={appTrendQuery.data ?? null}
              appTrendPeriod={appTrendPeriod}
              setAppTrendPeriod={setAppTrendPeriod}
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
              isAppTrendRefreshing={appTrendQuery.isFetching}
              isCalendarRefreshing={calendarQuery.isFetching}
              appTrendError={errorToNullableMessage(appTrendQuery.error)}
              onCalendarMonthChange={selectCalendarMonth}
              onSelectDate={selectDate}
            />
          ) : null}

          {page === 'timeline' ? (
            <TimelinePage
              dashboard={timelineDashboard}
              loading={!timelineDashboard}
              appFilter={appFilter}
              selectedDate={resolvedSelectedDate}
              activeOnly={timelineActiveOnly}
              searchQuery={timelineSearchQuery}
              focusSearchRequest={timelineSearchFocusRequest}
              segmentKind={timelineSegmentKind}
              focusedSegmentId={focusedSegmentId}
              viewStartHour={dateState.viewport.viewStartHour}
              viewStartSec={dateState.viewport.viewStartSec}
              viewEndSec={dateState.viewport.viewEndSec}
              zoomHours={dateState.viewport.zoomHours}
              setActiveOnly={setTimelineActiveOnly}
              setSearchQuery={setTimelineSearchQuery}
              setSegmentKind={setTimelineSegmentKind}
              setFocusedSegmentId={setFocusedSegmentId}
              setZoomHours={dateState.setZoomHours}
              setViewStartHour={dateState.setViewStartHour}
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
              savingTracking={pauseTrackingMutation.isPending || resumeTrackingMutation.isPending}
              deletingData={deleteDataMutation.isPending}
              isSettingsRefreshing={settingsQuery.isFetching && Boolean(settingsQuery.data)}
              theme={theme}
              onChangeTheme={setTheme}
              onPauseTracking={(payload) => pauseTrackingMutation.mutateAsync(payload)}
              onResumeTracking={() => resumeTrackingMutation.mutateAsync()}
              onUpdateRetention={(days) => retentionMutation.mutateAsync(days).then(() => undefined)}
              onDeleteData={async (payload: DeleteDataRequest) => {
                setSettingsError(null)
                setSettingsNotice(null)
                try {
                  await deleteDataMutation.mutateAsync(payload)
                  setSettingsNotice(payload.all ? '已删除全部本地活动数据。' : '已删除所选日期范围的数据。')
                } catch (deleteError) {
                  setSettingsError(errorToMessage(deleteError, '删除数据失败'))
                }
              }}
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
        </Suspense>
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
