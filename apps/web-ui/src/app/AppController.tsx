import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './AppShell'
import { useHashRoute } from './page-route'
import { useSelectedDateState } from './use-selected-date-state'
import {
  useAgentSettingsQuery,
  useInstallUpdateMutation,
  useMonthCalendarQuery,
  usePeriodSummaryQuery,
  useTimelineDayQuery,
  useUpdateAgentConfigMutation,
  useUpdateAutostartMutation,
  useUpdateCheckMutation,
  type AppUpdateInfo,
  type InstallUpdateResponse,
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
import { SettingsPage } from '../pages/settings-page'
import { StatsPage } from '../pages/stats-page'
import { TimelinePage } from '../pages/timeline-page'
import type { TimelineSegmentKind } from '../features/timeline/timeline-selectors'

export function AppController() {
  const { theme, setTheme } = useTheme()
  const [page, setPage] = useHashRoute()
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateNotice, setUpdateNotice] = useState<string | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [timelineActiveOnly, setTimelineActiveOnly] = useState(false)
  const [timelineSearchQuery, setTimelineSearchQuery] = useState('')
  const [timelineSegmentKind, setTimelineSegmentKind] =
    useState<TimelineSegmentKind>('all')
  const [focusedSegmentId, setFocusedSegmentId] = useState<string | null>(null)
  const didAutoCheckUpdateRef = useRef(false)

  const timelineQuery = useTimelineDayQuery(null)
  const timeline = timelineQuery.data ?? null
  const periodQuery = usePeriodSummaryQuery(timeline?.date ?? null)
  const settingsQuery = useAgentSettingsQuery()
  const agentToday = periodQuery.data?.date ?? null
  const agentTimezone = timeline?.timezone ?? null
  const dateState = useSelectedDateState({ agentToday, agentTimezone })
  const selectedTimelineQuery = useTimelineDayQuery(dateState.selectedDate, {
    enabled: dateState.selectedDate !== null,
  })
  const selectedPeriodQuery = usePeriodSummaryQuery(dateState.selectedDate, {
    enabled: dateState.selectedDate !== null,
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
  const checkUpdateMutation = useUpdateCheckMutation()
  const installUpdateMutation = useInstallUpdateMutation()
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

  useEffect(() => {
    if (lastTimelineDataUpdatedAt > 0) {
      setLastUpdatedAt(new Date(lastTimelineDataUpdatedAt).toLocaleTimeString())
    }
  }, [lastTimelineDataUpdatedAt])

  const refreshUpdateInfo = useCallback(
    async (silent = false) => {
      if (!silent) {
        setCheckingUpdate(true)
      }
      setUpdateError(null)
      setUpdateNotice(null)

      try {
        const nextUpdateInfo = await checkUpdateMutation.mutateAsync()
        setUpdateInfo(nextUpdateInfo)
        setUpdateNotice(
          nextUpdateInfo.has_update
            ? `发现新版本 ${nextUpdateInfo.latest_version}，可以直接在线升级。`
            : '当前已经是最新版本。',
        )
      } catch (loadError) {
        setUpdateError(errorToMessage(loadError, '检查更新时发生未知错误'))
      } finally {
        if (!silent) {
          setCheckingUpdate(false)
        }
      }
    },
    [checkUpdateMutation],
  )

  useEffect(() => {
    if (page !== 'settings' || !settingsQuery.data || didAutoCheckUpdateRef.current) {
      return
    }

    didAutoCheckUpdateRef.current = true
    void refreshUpdateInfo(true)
  }, [page, refreshUpdateInfo, settingsQuery.data])

  const dashboard = useMemo(
    () => (selectedTimeline ? buildDashboardModel(selectedTimeline, false) : null),
    [selectedTimeline],
  )
  const timelineDashboard = useMemo(
    () =>
      selectedTimeline
        ? buildDashboardModel(selectedTimeline, timelineActiveOnly)
        : null,
    [selectedTimeline, timelineActiveOnly],
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
    setDomainFilter(null)
    setFocusedSegmentId(null)
  }

  function selectCalendarMonth(nextMonth: string) {
    dateState.selectCalendarMonth(nextMonth)
    setDomainFilter(null)
    setFocusedSegmentId(null)
  }

  async function handleInstallLatestUpdate() {
    setUpdateError(null)
    setUpdateNotice(null)

    try {
      const result: InstallUpdateResponse = await installUpdateMutation.mutateAsync()
      setUpdateNotice(`已开始升级到 ${result.target_version}，本地服务即将自动重启。`)
    } catch (installError) {
      setUpdateError(errorToMessage(installError, '启动在线升级失败'))
    }
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
              isCalendarRefreshing={calendarQuery.isFetching}
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
              updateInfo={updateInfo}
              updateError={updateError}
              updateNotice={updateNotice}
              lastUpdatedAt={lastUpdatedAt}
              selectedDate={resolvedSelectedDate}
              timezone={resolvedTimezone}
              savingAutostart={updateAutostartMutation.isPending}
              savingConfig={updateConfigMutation.isPending}
              isSettingsRefreshing={settingsQuery.isFetching && Boolean(settingsQuery.data)}
              checkingUpdate={checkingUpdate}
              installingUpdate={installUpdateMutation.isPending}
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
              onCheckUpdate={async () => {
                await refreshUpdateInfo()
              }}
              onInstallUpdate={async () => {
                await handleInstallLatestUpdate()
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
