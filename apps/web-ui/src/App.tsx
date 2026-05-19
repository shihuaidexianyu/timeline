/* ActivityWatch-inspired multi-page dashboard for stats, timeline, and settings. */

import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  getAppUpdateInfo,
  getAgentSettings,
  getMonthCalendar,
  getPeriodSummary,
  getTimeline,
  installLatestUpdate,
  updateAgentConfig,
  updateAutostart,
  type AgentSettingsResponse,
  type AppUpdateInfo,
  type InstallUpdateResponse,
  type MonthCalendarResponse,
  type PeriodSummaryResponse,
  type TimelineDayResponse,
} from './api'
import {
  buildDashboardModel,
  type DashboardFilter,
} from './lib/chart-model'
import {
  buildWeekSeries,
  coerceDateIntoMonth,
  defaultTimelineViewport,
  isValidDateKey,
  monthFromDate,
} from './lib/dashboard-helpers'
import { SettingsPage } from './pages/settings-page'
import { StatsPage } from './pages/stats-page'
import { TimelinePage, type TimelineSegmentKind } from './pages/timeline-page'
import { useTheme } from './hooks/use-theme'

const PAGE_ITEMS = [
  { id: 'stats', label: '统计' },
  { id: 'timeline', label: '时间线' },
  { id: 'settings', label: '设置' },
] as const

type AppPage = (typeof PAGE_ITEMS)[number]['id']

function App() {
  const { theme, setTheme } = useTheme()
  const [page, setPage] = useHashPage()
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TimelineDayResponse | null>(null)
  const [agentSettings, setAgentSettings] = useState<AgentSettingsResponse | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isTimelineRefreshing, setIsTimelineRefreshing] = useState(false)
  const [isPeriodRefreshing, setIsPeriodRefreshing] = useState(false)
  const [isSettingsRefreshing, setIsSettingsRefreshing] = useState(false)
  const [isCalendarRefreshing, setIsCalendarRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateNotice, setUpdateNotice] = useState<string | null>(null)
  const [savingAutostart, setSavingAutostart] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [timelineActiveOnly, setTimelineActiveOnly] = useState(false)
  const [timelineSearchQuery, setTimelineSearchQuery] = useState('')
  const [timelineSegmentKind, setTimelineSegmentKind] = useState<TimelineSegmentKind>('all')
  const [focusedSegmentId, setFocusedSegmentId] = useState<string | null>(null)
  const [zoomHours, setZoomHours] = useState<number>(0.5)
  const [viewStartHour, setViewStartHour] = useState(0)
  const [periodSummary, setPeriodSummary] = useState<PeriodSummaryResponse | null>(null)
  const [calendarMonth, setCalendarMonth] = useState<string | null>(null)
  const [monthCalendar, setMonthCalendar] = useState<MonthCalendarResponse | null>(null)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [agentToday, setAgentToday] = useState<string | null>(null)
  const [agentTimezone, setAgentTimezone] = useState<string | null>(null)
  const skipNextDateLoadRef = useRef(false)
  const didAutoCheckUpdateRef = useRef(false)

  useEffect(() => {
    if (selectedDate !== null) {
      return
    }

    let cancelled = false

    async function bootstrap() {
      setIsBootstrapping(true)
      setIsTimelineRefreshing(true)
      setIsPeriodRefreshing(true)
      setIsSettingsRefreshing(true)
      setError(null)

      try {
        const [nextTimeline, nextSettings, nextPeriod] = await Promise.all([
          getTimeline(),
          getAgentSettings(),
          getPeriodSummary(),
        ])
        if (cancelled) {
          return
        }

        const resolvedDate = nextTimeline.date
        const nextWindow = defaultTimelineViewport(
          resolvedDate,
          nextPeriod.date,
          nextTimeline.timezone,
        )

        skipNextDateLoadRef.current = true
        setSelectedDate(resolvedDate)
        setCalendarMonth(monthFromDate(resolvedDate))
        setAgentToday(nextPeriod.date)
        setAgentTimezone(nextTimeline.timezone)
        setZoomHours(nextWindow.zoomHours)
        setViewStartHour(nextWindow.viewStartHour)
        setTimeline(nextTimeline)
        setAgentSettings(nextSettings)
        setPeriodSummary(nextPeriod)
        setSettingsError(null)
        setLastUpdatedAt(new Date().toLocaleTimeString())
      } catch (loadError) {
        if (cancelled) {
          return
        }

        const message =
          loadError instanceof Error ? loadError.message : '加载本地数据时发生未知错误'
        setError(message)
      } finally {
        if (!cancelled) {
          setIsTimelineRefreshing(false)
          setIsPeriodRefreshing(false)
          setIsSettingsRefreshing(false)
          setIsBootstrapping(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [selectedDate])

  useEffect(() => {
    if (selectedDate === null) {
      return
    }

    const currentDate = selectedDate

    if (skipNextDateLoadRef.current) {
      skipNextDateLoadRef.current = false
      return
    }

    let cancelled = false

    async function loadSelectedDate() {
      setIsTimelineRefreshing(true)
      setIsPeriodRefreshing(true)
      setError(null)

      const [timelineResult, periodResult] = await Promise.allSettled([
        getTimeline(currentDate),
        getPeriodSummary(currentDate),
      ])

      if (cancelled) {
        return
      }

      let nextError: string | null = null

      if (timelineResult.status === 'fulfilled') {
        setTimeline(timelineResult.value)
        setAgentTimezone(timelineResult.value.timezone)
        setLastUpdatedAt(new Date().toLocaleTimeString())
      } else {
        if (cancelled) {
          return
        }

        const message =
          timelineResult.reason instanceof Error
            ? timelineResult.reason.message
            : '加载时间线数据时发生未知错误'
        nextError = message
      }

      if (periodResult.status === 'fulfilled') {
        setPeriodSummary(periodResult.value)
        setAgentToday(periodResult.value.date)
      } else {
        const message =
          periodResult.reason instanceof Error
            ? periodResult.reason.message
            : '加载统计汇总时发生未知错误'
        nextError = nextError ?? message
      }

      setError(nextError)
      if (!cancelled) {
        setIsTimelineRefreshing(false)
        setIsPeriodRefreshing(false)
      }
    }

    void loadSelectedDate()

    return () => {
      cancelled = true
    }
  }, [selectedDate])

  useEffect(() => {
    if (calendarMonth === null) {
      return
    }

    let cancelled = false
    setCalendarError(null)
    setIsCalendarRefreshing(true)

    void getMonthCalendar(calendarMonth)
      .then((data) => {
        if (!cancelled) {
          setMonthCalendar(data)
          setIsCalendarRefreshing(false)
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          const message =
            loadError instanceof Error ? loadError.message : '加载月历数据时发生未知错误'
          setCalendarError(message)
          setIsCalendarRefreshing(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [calendarMonth])

  useEffect(() => {
    setViewStartHour((current) => Math.max(0, Math.min(current, 24 - zoomHours)))
  }, [zoomHours])

  useEffect(() => {
    if (page !== 'settings' || agentSettings === null || didAutoCheckUpdateRef.current) {
      return
    }

    didAutoCheckUpdateRef.current = true
    void refreshUpdateInfo(true)
  }, [agentSettings, page])

  const dashboard = useMemo(
    () => (timeline ? buildDashboardModel(timeline, false) : null),
    [timeline],
  )
  const timelineDashboard = useMemo(
    () => (timeline ? buildDashboardModel(timeline, timelineActiveOnly) : null),
    [timeline, timelineActiveOnly],
  )

  const viewStartSec = viewStartHour * 3600
  const viewEndSec = viewStartSec + zoomHours * 3600
  const pageInfo = pageMeta(page)
  const resolvedSelectedDate = selectedDate ?? timeline?.date ?? '--'
  const weekBars = useMemo(
    () =>
      isValidDateKey(resolvedSelectedDate)
        ? buildWeekSeries(monthCalendar?.days ?? [], resolvedSelectedDate)
        : [],
    [monthCalendar?.days, resolvedSelectedDate],
  )
  const hasDashboard = dashboard !== null
  const shouldRenderPage = hasDashboard || (isBootstrapping && !error)

  async function refreshUpdateInfo(silent = false) {
    if (!silent) {
      setCheckingUpdate(true)
    }
    setUpdateError(null)
    setUpdateNotice(null)

    try {
      const nextUpdateInfo = await getAppUpdateInfo()
      setUpdateInfo(nextUpdateInfo)
      setUpdateNotice(
        nextUpdateInfo.has_update
          ? `发现新版本 ${nextUpdateInfo.latest_version}，可以直接在线升级。`
          : '当前已经是最新版本。',
      )
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : '检查更新时发生未知错误'
      setUpdateError(message)
    } finally {
      if (!silent) {
        setCheckingUpdate(false)
      }
    }
  }

  async function handleInstallLatestUpdate() {
    setInstallingUpdate(true)
    setUpdateError(null)
    setUpdateNotice(null)

    try {
      const result: InstallUpdateResponse = await installLatestUpdate()
      setUpdateNotice(`已开始升级到 ${result.target_version}，本地服务即将自动重启。`)
    } catch (installError) {
      const message =
        installError instanceof Error ? installError.message : '启动在线升级失败'
      setUpdateError(message)
    } finally {
      setInstallingUpdate(false)
    }
  }

  function applySelectedDate(nextDate: string) {
    const nextWindow = defaultTimelineViewport(nextDate, agentToday, agentTimezone)

    startTransition(() => {
      setSelectedDate(nextDate)
      setCalendarMonth(monthFromDate(nextDate))
      setDomainFilter(null)
      setFocusedSegmentId(null)
      setZoomHours(nextWindow.zoomHours)
      setViewStartHour(nextWindow.viewStartHour)
    })
  }

  function handleCalendarMonthChange(nextMonth: string) {
    const baseDate = selectedDate ?? agentToday ?? `${nextMonth}-01`
    const nextDate = coerceDateIntoMonth(nextMonth, baseDate)
    const nextWindow = defaultTimelineViewport(nextDate, agentToday, agentTimezone)

    startTransition(() => {
      setCalendarMonth(nextMonth)
      setSelectedDate(nextDate)
      setDomainFilter(null)
      setFocusedSegmentId(null)
      setZoomHours(nextWindow.zoomHours)
      setViewStartHour(nextWindow.viewStartHour)
    })
  }

  return (
    <main className="app-shell app-layout">
      <aside className="sidebar-shell">
        <div className="sidebar-brand">
          <h1>TimeLine</h1>
        </div>

        <nav className="sidebar-nav" aria-label="页面">
          {PAGE_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sidebar-nav-button ${page === item.id ? 'is-active' : ''}`}
              onClick={() => {
                setPage(item.id)
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-status">
          <span>服务状态</span>
          <strong className={error ? 'status-error' : 'status-ok'}>
            {error ? '离线' : '在线'}
          </strong>
          <small>{lastUpdatedAt ? `${lastUpdatedAt} 更新` : '等待连接'}</small>
        </div>
      </aside>

      <section className="main-shell">
        <header className="page-header">
          <div>
            <p className="eyebrow">{pageInfo.kicker}</p>
            <h2 className="page-title">{pageInfo.title}</h2>
            <p className="hero-text">{pageInfo.description}</p>
          </div>
          <div className="activity-meta">
            <span>
              <strong>日期</strong>
              {resolvedSelectedDate}
            </span>
            <span>
              <strong>时区</strong>
              {agentTimezone ?? timeline?.timezone ?? '--'}
            </span>
          </div>
        </header>

        {error && !hasDashboard && !shouldRenderPage ? <ErrorState error={error} /> : null}
        {error && hasDashboard ? <InlineErrorState error={error} /> : null}

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
                periodSummary={periodSummary}
                calendarDays={monthCalendar?.days ?? []}
                calendarMonth={calendarMonth ?? monthFromDate(resolvedSelectedDate)}
                selectedDate={resolvedSelectedDate}
                agentToday={agentToday}
                calendarError={calendarError}
                weekBars={weekBars}
                isTimelineRefreshing={isTimelineRefreshing}
                isPeriodRefreshing={isPeriodRefreshing}
                isCalendarRefreshing={isCalendarRefreshing}
                onCalendarMonthChange={handleCalendarMonthChange}
                onSelectDate={applySelectedDate}
              />
            ) : null}

            {page === 'timeline' ? (
              <TimelinePage
                dashboard={timelineDashboard}
                loading={!hasDashboard}
                appFilter={appFilter}
                selectedDate={resolvedSelectedDate}
                activeOnly={timelineActiveOnly}
                searchQuery={timelineSearchQuery}
                segmentKind={timelineSegmentKind}
                focusedSegmentId={focusedSegmentId}
                viewStartHour={viewStartHour}
                viewStartSec={viewStartSec}
                viewEndSec={viewEndSec}
                zoomHours={zoomHours}
                setActiveOnly={setTimelineActiveOnly}
                setSearchQuery={setTimelineSearchQuery}
                setSegmentKind={setTimelineSegmentKind}
                setFocusedSegmentId={setFocusedSegmentId}
                setZoomHours={setZoomHours}
                setViewStartHour={setViewStartHour}
              />
            ) : null}

            {page === 'settings' ? (
              <SettingsPage
                agentSettings={agentSettings}
                loading={!hasDashboard}
                error={error}
                settingsError={settingsError}
                settingsNotice={settingsNotice}
                updateInfo={updateInfo}
                updateError={updateError}
                updateNotice={updateNotice}
                lastUpdatedAt={lastUpdatedAt}
                selectedDate={resolvedSelectedDate}
                timezone={agentTimezone ?? timeline?.timezone ?? '--'}
                savingAutostart={savingAutostart}
                savingConfig={savingConfig}
                isSettingsRefreshing={isSettingsRefreshing}
                checkingUpdate={checkingUpdate}
                installingUpdate={installingUpdate}
                theme={theme}
                onChangeTheme={setTheme}
                onToggleAutostart={async (enabled) => {
                  setSavingAutostart(true)
                  setSettingsError(null)
                  setSettingsNotice(null)

                  try {
                    const result = await updateAutostart({ enabled })
                    setAgentSettings((current) =>
                      current
                        ? {
                          ...current,
                          autostart_enabled: result.autostart_enabled,
                        }
                        : current,
                    )
                  } catch (toggleError) {
                    const message =
                      toggleError instanceof Error
                        ? toggleError.message
                        : '更新开机自启动设置失败'
                    setSettingsError(message)
                  } finally {
                    setSavingAutostart(false)
                  }
                }}
                onUpdateConfig={async (payload) => {
                  setSavingConfig(true)
                  setSettingsError(null)
                  setSettingsNotice(null)

                  try {
                    const result = await updateAgentConfig(payload)
                    if (result.saved) {
                      setAgentSettings((current) =>
                        current
                          ? {
                            ...current,
                            idle_threshold_secs: payload.idle_threshold_secs,
                            poll_interval_millis: payload.poll_interval_millis,
                            health_reminder_enabled: payload.health_reminder_enabled,
                            health_reminder_threshold_secs:
                              payload.health_reminder_threshold_secs,
                            record_window_titles: payload.record_window_titles,
                            record_page_titles: payload.record_page_titles,
                            ignored_apps: payload.ignored_apps,
                            ignored_domains: payload.ignored_domains,
                          }
                          : current,
                      )
                      setSettingsNotice(
                        result.requires_restart
                          ? '设置已保存，重启 timeline 后生效。'
                          : null,
                      )
                    }
                  } catch (updateError) {
                    const message =
                      updateError instanceof Error ? updateError.message : '更新本地配置失败'
                    setSettingsError(message)
                  } finally {
                    setSavingConfig(false)
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
      </section>
    </main>
  )
}

function ErrorState(props: { error: string }) {
  return <div className="state-card error-card">{props.error}</div>
}

function InlineErrorState(props: { error: string }) {
  return <div className="inline-error-banner">{props.error}</div>
}

function useHashPage(): [AppPage, (page: AppPage) => void] {
  const [page, setPage] = useState<AppPage>(() => pageFromHash(window.location.hash))

  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = '#/stats'
    }

    function handleHashChange() {
      setPage(pageFromHash(window.location.hash))
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => {
      window.removeEventListener('hashchange', handleHashChange)
    }
  }, [])

  return [
    page,
    (nextPage) => {
      window.location.hash = `#/${nextPage}`
      setPage(nextPage)
    },
  ]
}

function pageFromHash(hash: string): AppPage {
  const normalized = hash.replace(/^#\/?/, '')
  if (normalized === 'timeline' || normalized === 'settings' || normalized === 'stats') {
    return normalized
  }
  return 'stats'
}

function pageMeta(page: AppPage) {
  if (page === 'timeline') {
    return {
      kicker: '时间线',
      title: '时间线',
      description: '查看当前窗口内的事件分布与进程记录。',
    }
  }

  if (page === 'settings') {
    return {
      kicker: '设置',
      title: '本地设置',
      description: '查看当前连接、本地采集范围和运行配置。',
    }
  }

  return {
    kicker: '统计',
    title: '统计概览',
    description: '按天查看应用使用、状态分布和周期变化。',
  }
}

export default App
