/* ActivityWatch-inspired multi-page dashboard for stats, timeline, and settings. */

import { memo, startTransition, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  API_BASE_URL,
  getAgentSettings,
  getMonthCalendar,
  getPeriodSummary,
  getTimeline,
  updateAgentConfig,
  updateAutostart,
  type AgentSettingsResponse,
  type DaySummary,
  type MonthCalendarResponse,
  type PeriodSummaryResponse,
  type TimelineDayResponse,
} from './api'
import { CalendarGrid } from './components/calendar-grid'
import { CompactDonutChart, DonutChart } from './components/donut-chart'
import { TimelineClock } from './components/timeline-clock'
import { TimelineChart } from './components/timeline-chart'
import {
  buildDashboardModel,
  formatClockRange,
  formatDuration,
  type ChartSegment,
  type DashboardFilter,
  type DashboardModel,
  type DonutSlice,
} from './lib/chart-model'

const MAX_ZOOM_HOURS = 8
const MIN_ZOOM_HOURS = 1 / 12
const PAGE_ITEMS = [
  { id: 'stats', label: '统计' },
  { id: 'timeline', label: '时间线' },
  { id: 'settings', label: '设置' },
] as const

type AppPage = (typeof PAGE_ITEMS)[number]['id']

function App() {
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
  const [savingAutostart, setSavingAutostart] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const activeOnly = false
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [zoomHours, setZoomHours] = useState<number>(0.5)
  const [viewStartHour, setViewStartHour] = useState(0)
  const [periodSummary, setPeriodSummary] = useState<PeriodSummaryResponse | null>(null)
  const [calendarMonth, setCalendarMonth] = useState<string | null>(null)
  const [monthCalendar, setMonthCalendar] = useState<MonthCalendarResponse | null>(null)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [agentToday, setAgentToday] = useState<string | null>(null)
  const [agentTimezone, setAgentTimezone] = useState<string | null>(null)
  const skipNextDateLoadRef = useRef(false)

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
    setViewStartHour((current) => clampViewStart(current, zoomHours))
  }, [zoomHours])

  const dashboard = useMemo(
    () => (timeline ? buildDashboardModel(timeline, activeOnly) : null),
    [activeOnly, timeline],
  )

  const viewStartSec = viewStartHour * 3600
  const viewEndSec = viewStartSec + zoomHours * 3600
  const pageInfo = pageMeta(page)
  const resolvedSelectedDate = selectedDate ?? timeline?.date ?? '--'
  const hasDashboard = dashboard !== null
  const showInitialLoading = !hasDashboard && isBootstrapping

  function applySelectedDate(nextDate: string) {
    const nextWindow = defaultTimelineViewport(nextDate, agentToday, agentTimezone)

    startTransition(() => {
      setSelectedDate(nextDate)
      setCalendarMonth(monthFromDate(nextDate))
      setDomainFilter(null)
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

        {showInitialLoading ? <LoadingState /> : null}
        {error && !hasDashboard ? <ErrorState error={error} /> : null}
        {error && hasDashboard ? <InlineErrorState error={error} /> : null}

        {dashboard ? (
          <>
            {page === 'stats' ? (
              <StatsPage
                dashboard={dashboard}
                appFilter={appFilter}
                domainFilter={domainFilter}
                setAppFilter={setAppFilter}
                setDomainFilter={setDomainFilter}
                periodSummary={periodSummary}
                monthCalendar={monthCalendar}
                calendarMonth={calendarMonth ?? monthFromDate(resolvedSelectedDate)}
                selectedDate={resolvedSelectedDate}
                agentToday={agentToday}
                calendarError={calendarError}
                isTimelineRefreshing={isTimelineRefreshing}
                isPeriodRefreshing={isPeriodRefreshing}
                isCalendarRefreshing={isCalendarRefreshing}
                onCalendarMonthChange={handleCalendarMonthChange}
                onSelectDate={applySelectedDate}
              />
            ) : null}

            {page === 'timeline' ? (
              <TimelinePage
                dashboard={dashboard}
                appFilter={appFilter}
                selectedDate={resolvedSelectedDate}
                viewStartHour={viewStartHour}
                viewStartSec={viewStartSec}
                viewEndSec={viewEndSec}
                zoomHours={zoomHours}
                setZoomHours={setZoomHours}
                setViewStartHour={setViewStartHour}
              />
            ) : null}

            {page === 'settings' ? (
              <SettingsPage
                agentSettings={agentSettings}
                error={error}
                settingsError={settingsError}
                settingsNotice={settingsNotice}
                lastUpdatedAt={lastUpdatedAt}
                selectedDate={resolvedSelectedDate}
                timezone={agentTimezone ?? timeline?.timezone ?? '--'}
                savingAutostart={savingAutostart}
                savingConfig={savingConfig}
                isSettingsRefreshing={isSettingsRefreshing}
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
                            record_window_titles: payload.record_window_titles,
                            record_page_titles: payload.record_page_titles,
                            ignored_apps: payload.ignored_apps,
                            ignored_domains: payload.ignored_domains,
                          }
                          : current,
                      )
                      setSettingsNotice(
                        result.requires_restart
                          ? '设置已保存，重启 timeline-agent 后生效。'
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
              />
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  )
}

function StatsPage(props: {
  dashboard: DashboardModel
  appFilter: DashboardFilter
  domainFilter: DashboardFilter
  setAppFilter: (value: DashboardFilter) => void
  setDomainFilter: (value: DashboardFilter) => void
  periodSummary: PeriodSummaryResponse | null
  monthCalendar: MonthCalendarResponse | null
  calendarMonth: string
  selectedDate: string
  agentToday: string | null
  calendarError: string | null
  isTimelineRefreshing: boolean
  isPeriodRefreshing: boolean
  isCalendarRefreshing: boolean
  onCalendarMonthChange: (month: string) => void
  onSelectDate: (date: string) => void
}) {
  const weekBars = buildWeekSeries(props.monthCalendar?.days ?? [], props.selectedDate)
  const presenceByKey = new Map(
    props.dashboard.presenceSlices.map((slice) => [slice.key, slice.value]),
  )

  return (
    <section className="page-stack">
      <section className="stats-overview-grid">
        <WeeklyRhythmCard
          periodSummary={props.periodSummary}
          weekBars={weekBars}
          refreshing={props.isPeriodRefreshing}
          onSelectDate={props.onSelectDate}
        />
        <FocusBalanceCard
          dashboard={props.dashboard}
          activeSeconds={presenceByKey.get('active') ?? 0}
          idleSeconds={presenceByKey.get('idle') ?? 0}
          lockedSeconds={presenceByKey.get('locked') ?? 0}
          refreshing={props.isTimelineRefreshing}
        />
      </section>

      <section className="stats-analysis-grid">
        <div className="panel page-panel stats-analysis-card">
          <div className="panel-header">
            <div>
              <h2>应用分布</h2>
            </div>
            <RefreshBadge active={props.isTimelineRefreshing} />
          </div>
          <DonutChart
            title="应用分布"
            totalLabel={formatDuration(props.dashboard.summary.focusSeconds)}
            slices={props.dashboard.appSlices}
            filter={props.appFilter}
            filterKind="app"
            onSelect={props.setAppFilter}
          />
        </div>

        <div className="panel page-panel stats-analysis-card">
          <div className="panel-header">
            <div>
              <h2>域名分布</h2>
            </div>
            <RefreshBadge active={props.isTimelineRefreshing} />
          </div>
          <DonutChart
            title="域名分布"
            totalLabel={formatDuration(sumSlices(props.dashboard.domainSlices))}
            slices={props.dashboard.domainSlices}
            filter={props.domainFilter}
            filterKind="domain"
            onSelect={props.setDomainFilter}
          />
        </div>

        <div className="panel page-panel stats-calendar-card">
          <div className="panel-header">
            <div>
              <h2>使用热度</h2>
            </div>
            <RefreshBadge active={props.isCalendarRefreshing} />
          </div>
          {props.monthCalendar ? (
            <CalendarGrid
              month={props.calendarMonth}
              days={props.monthCalendar.days}
              selectedDate={props.selectedDate}
              todayDate={props.agentToday}
              onSelectDate={props.onSelectDate}
              onMonthChange={props.onCalendarMonthChange}
            />
          ) : props.calendarError ? (
            <div className="state-card error-card">{props.calendarError}</div>
          ) : (
            <div className="state-card">加载中…</div>
          )}
        </div>
      </section>
    </section>
  )
}

function WeeklyRhythmCard(props: {
  periodSummary: PeriodSummaryResponse | null
  weekBars: WeekBarDatum[]
  refreshing: boolean
  onSelectDate: (date: string) => void
}) {
  const weekActiveTotal = props.periodSummary?.week.active_seconds ?? 0
  const weekFocusTotal = props.periodSummary?.week.focus_seconds ?? 0
  const monthActiveTotal = props.periodSummary?.month.active_seconds ?? 0
  const monthFocusTotal = props.periodSummary?.month.focus_seconds ?? 0

  return (
    <article className="showcase-card showcase-card-dashboard">
      <div className="showcase-card-head">
        <div>
          <h2>本周节奏</h2>
        </div>
        <div className="card-head-side">
          <RefreshBadge active={props.refreshing} />
          <div className="weekly-legend" aria-label="本周节奏图例">
            <span className="weekly-legend-item is-active">活跃</span>
            <span className="weekly-legend-item is-focus">应用</span>
          </div>
        </div>
      </div>

      <div className="weekly-summary-row">
        <div>
          <strong>{formatDuration(weekActiveTotal)}</strong>
          <small>本周活跃 · 当月 {formatDuration(monthActiveTotal)}</small>
        </div>
        <div>
          <strong>{formatDuration(weekFocusTotal)}</strong>
          <small>本周应用 · 当月 {formatDuration(monthFocusTotal)}</small>
        </div>
      </div>

      <WeeklyBarChart bars={props.weekBars} onSelectDate={props.onSelectDate} />
    </article>
  )
}

function FocusBalanceCard(props: {
  dashboard: DashboardModel
  activeSeconds: number
  idleSeconds: number
  lockedSeconds: number
  refreshing: boolean
}) {
  const activeRatio =
    props.dashboard.summary.focusSeconds > 0
      ? props.dashboard.summary.activeSeconds / props.dashboard.summary.focusSeconds
      : 0
  const [selectedPresenceKey, setSelectedPresenceKey] = useState<'active' | 'idle' | 'locked'>('active')
  const selectedPresenceLabel =
    selectedPresenceKey === 'active' ? '活跃' : selectedPresenceKey === 'idle' ? '空闲' : '锁定'
  const selectedPresenceValue =
    selectedPresenceKey === 'active'
      ? props.activeSeconds
      : selectedPresenceKey === 'idle'
        ? props.idleSeconds
        : props.lockedSeconds
  const presenceTotal = props.activeSeconds + props.idleSeconds + props.lockedSeconds
  const presenceSlices: DonutSlice[] = [
    {
      id: 'presence-active',
      key: 'active',
      label: '活跃',
      value: props.activeSeconds,
      percentage: presenceTotal === 0 ? 0 : (props.activeSeconds / presenceTotal) * 100,
      color: '#2f6fdb',
    },
    {
      id: 'presence-idle',
      key: 'idle',
      label: '空闲',
      value: props.idleSeconds,
      percentage: presenceTotal === 0 ? 0 : (props.idleSeconds / presenceTotal) * 100,
      color: '#43d6b0',
    },
    {
      id: 'presence-locked',
      key: 'locked',
      label: '锁定',
      value: props.lockedSeconds,
      percentage: presenceTotal === 0 ? 0 : (props.lockedSeconds / presenceTotal) * 100,
      color: '#8b7dff',
    },
  ]

  return (
    <article className="showcase-card showcase-card-focus">
      <div className="showcase-card-head">
        <div>
          <h2>状态分布</h2>
        </div>
        <RefreshBadge active={props.refreshing} />
      </div>

      <div className="focus-distribution-layout">
        <div className="showcase-donut-wrap">
          <div className="showcase-compact-donut">
            <CompactDonutChart
              slices={presenceSlices}
              totalLabel={formatDuration(selectedPresenceValue)}
              secondaryLabel={selectedPresenceLabel}
              footerLabel={`应用 ${formatDuration(props.dashboard.summary.focusSeconds)}`}
              selectedKey={selectedPresenceKey}
              onSelectKey={(key) => {
                if (key === 'active' || key === 'idle' || key === 'locked') {
                  setSelectedPresenceKey(key)
                }
              }}
              height={232}
              emptyLabel="所选日期没有状态分布数据"
            />
          </div>
        </div>

        <div className="presence-legend">
          <button
            type="button"
            className={`presence-legend-item ${selectedPresenceKey === 'active' ? 'is-selected' : ''}`}
            onClick={() => setSelectedPresenceKey('active')}
          >
            <span className="presence-legend-name">
              <i style={{ backgroundColor: '#2f6fdb' }} />
              活跃
            </span>
            <strong>{formatDuration(props.activeSeconds)}</strong>
          </button>
          <button
            type="button"
            className={`presence-legend-item ${selectedPresenceKey === 'idle' ? 'is-selected' : ''}`}
            onClick={() => setSelectedPresenceKey('idle')}
          >
            <span className="presence-legend-name">
              <i style={{ backgroundColor: '#43d6b0' }} />
              空闲
            </span>
            <strong>{formatDuration(props.idleSeconds)}</strong>
          </button>
          <button
            type="button"
            className={`presence-legend-item ${selectedPresenceKey === 'locked' ? 'is-selected' : ''}`}
            onClick={() => setSelectedPresenceKey('locked')}
          >
            <span className="presence-legend-name">
              <i style={{ backgroundColor: '#8b7dff' }} />
              锁定
            </span>
            <strong>{formatDuration(props.lockedSeconds)}</strong>
          </button>
        </div>
      </div>

      <div className="focus-metric-stack">
        <div className="focus-metric-card">
          <span>最长连续</span>
          <strong>{formatDuration(props.dashboard.summary.longestFocusSeconds)}</strong>
        </div>
        <div className="focus-metric-card">
          <span>活跃占比</span>
          <strong>{formatPercent(activeRatio)}</strong>
        </div>
      </div>
    </article>
  )
}

type WeekBarDatum = {
  date: string
  dayLabel: string
  activeSeconds: number
  focusSeconds: number
  isSelected: boolean
}

function WeeklyBarChart(props: {
  bars: WeekBarDatum[]
  onSelectDate: (date: string) => void
}) {
  const maxValue = Math.max(
    ...props.bars.map((bar) => Math.max(bar.activeSeconds, bar.focusSeconds)),
    1,
  )
  const axisMaxValue = niceWeeklyAxisMax(maxValue)
  const axisTicks = [axisMaxValue, axisMaxValue / 2, 0]

  return (
    <div className="weekly-chart-shell">
      <div className="weekly-chart-main">
        {axisTicks.map((tick) => (
          <span
            key={tick}
            className="weekly-grid-line"
            style={{ bottom: `${axisMaxValue === 0 ? 0 : (tick / axisMaxValue) * 100}%` }}
          />
        ))}

        <div className="weekly-bars">
          {props.bars.map((bar) => {
            const normalizedFocusSeconds = Math.max(bar.focusSeconds, bar.activeSeconds)
            const focusExtraSeconds = Math.max(0, normalizedFocusSeconds - bar.activeSeconds)
            const hasFocusExtra = focusExtraSeconds > 0
            const activeBarHeight = `${Math.max(
              (bar.activeSeconds / axisMaxValue) * 100,
              bar.activeSeconds > 0 ? 10 : 0,
            )}%`
            const focusExtraBarHeight = `${Math.max(
              (focusExtraSeconds / axisMaxValue) * 100,
              focusExtraSeconds > 0 ? 10 : 0,
            )}%`

            return (
              <button
                key={bar.date}
                type="button"
                className={`weekly-bar-column ${bar.isSelected ? 'is-selected' : ''}`}
                onClick={() => props.onSelectDate(bar.date)}
                title={`${bar.date} 活跃 ${formatDuration(bar.activeSeconds)} · 应用 ${formatDuration(normalizedFocusSeconds)}`}
              >
                <div className="weekly-bar-track">
                  <div
                    className={`weekly-bar weekly-bar-active ${hasFocusExtra ? '' : 'is-cap'}`}
                    style={{ height: activeBarHeight }}
                  />
                  <div
                    className={`weekly-bar weekly-bar-focus-extra ${hasFocusExtra ? 'is-cap' : ''}`}
                    style={{
                      height: focusExtraBarHeight,
                      bottom: `calc(${activeBarHeight} - 2px)`,
                      opacity: focusExtraSeconds > 0 ? 1 : 0,
                    }}
                  />
                </div>
                <span className="weekly-bar-day">{bar.dayLabel}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="weekly-axis">
        {axisTicks.map((tick) => (
          <span key={`label-${tick}`} className="weekly-axis-label">
            {formatWeeklyAxisTick(tick)}
          </span>
        ))}
      </div>
    </div>
  )
}

function TimelinePage(props: {
  dashboard: DashboardModel
  appFilter: DashboardFilter
  selectedDate: string
  viewStartHour: number
  viewStartSec: number
  viewEndSec: number
  zoomHours: number
  setZoomHours: (hours: number) => void
  setViewStartHour: (hours: number) => void
}) {
  const [hoveredFocusSegmentId, setHoveredFocusSegmentId] = useState<string | null>(null)
  const visibleFocusItems = useMemo(
    () =>
      buildVisibleFocusItems(
        props.dashboard.focusSegments,
        props.viewStartSec,
        props.viewEndSec,
      ),
    [props.dashboard.focusSegments, props.viewEndSec, props.viewStartSec],
  )
  const browserDomainBySegmentId = useMemo(
    () => buildPrimaryBrowserDomainMap(visibleFocusItems, props.dashboard.browserSegments),
    [props.dashboard.browserSegments, visibleFocusItems],
  )
  const timelineRows = useMemo(
    () => [
      {
        id: 'focus',
        label: '应用',
        segments: props.dashboard.focusSegments,
        selectedKey: props.appFilter?.key ?? null,
        splitByKey: false,
      },
      {
        id: 'presence',
        label: '状态',
        segments: props.dashboard.presenceSegments,
        includeInTable: false,
      },
    ],
    [props.appFilter, props.dashboard.focusSegments, props.dashboard.presenceSegments],
  )
  const windowDurationSec = props.viewEndSec - props.viewStartSec
  const visibleAppCount = useMemo(
    () => new Set(visibleFocusItems.map((item) => item.key)).size,
    [visibleFocusItems],
  )
  const focusDurationSec = useMemo(
    () => sumOverlappedDuration(props.dashboard.focusSegments, props.viewStartSec, props.viewEndSec),
    [props.dashboard.focusSegments, props.viewEndSec, props.viewStartSec],
  )
  const activeDurationSec = useMemo(
    () =>
      sumOverlappedDuration(
        props.dashboard.presenceSegments.filter((segment) => segment.key === 'active'),
        props.viewStartSec,
        props.viewEndSec,
      ),
    [props.dashboard.presenceSegments, props.viewEndSec, props.viewStartSec],
  )
  const longestVisibleDurationSec = useMemo(
    () =>
      visibleFocusItems.reduce(
        (maxDuration, segment) =>
          Math.max(maxDuration, overlapDuration(segment, props.viewStartSec, props.viewEndSec)),
        0,
      ),
    [props.viewEndSec, props.viewStartSec, visibleFocusItems],
  )
  const focusCoverageRatio =
    windowDurationSec > 0 ? clampNumber(focusDurationSec / windowDurationSec, 0, 1) : 0
  const activeRatio =
    windowDurationSec > 0 ? clampNumber(activeDurationSec / windowDurationSec, 0, 1) : 0
  const windowLabel = `${formatHourLabel(props.viewStartHour)} - ${formatHourLabel(
    props.viewStartHour + props.zoomHours,
  )}`

  return (
    <section className="page-stack">
      <div className="page-content-layout timeline-page-layout">
        <div className="page-content-main">
          <div className="panel page-panel timeline-panel">
            <div className="panel-header">
              <div>
                <h2>事件时间线</h2>
              </div>
            </div>

            <div className="timeline-primary-chart">
              <TimelineChart
                rows={timelineRows}
                viewStartSec={props.viewStartSec}
                viewEndSec={props.viewEndSec}
                baseDate={props.selectedDate}
                windowLabel={windowLabel}
                windowDurationLabel={`窗口 ${formatDuration(windowDurationSec)}`}
                windowItemCount={visibleFocusItems.length}
                highlightedSegmentId={hoveredFocusSegmentId}
                interactiveZoom={false}
                minViewHours={MIN_ZOOM_HOURS}
                maxViewHours={MAX_ZOOM_HOURS}
                onSegmentHover={setHoveredFocusSegmentId}
                onViewportChange={(nextStartSec, nextEndSec) => {
                  const nextZoom = clampZoomHours(
                    normalizeZoomHours((nextEndSec - nextStartSec) / 3600),
                  )
                  const nextStartHour = normalizeZoomHours(nextStartSec / 3600)
                  props.setZoomHours(nextZoom)
                  props.setViewStartHour(clampViewStart(nextStartHour, nextZoom))
                }}
              />
            </div>

            <TimelineClock
              focusSegments={props.dashboard.focusSegments}
              presenceSegments={props.dashboard.presenceSegments}
              viewStartSec={props.viewStartSec}
              viewEndSec={props.viewEndSec}
              minViewSec={MIN_ZOOM_HOURS * 3600}
              maxViewSec={MAX_ZOOM_HOURS * 3600}
              onWindowChange={(nextStartSec, nextEndSec) => {
                const nextZoom = clampZoomHours(
                  normalizeZoomHours((nextEndSec - nextStartSec) / 3600),
                )
                const nextStartHour = normalizeZoomHours(nextStartSec / 3600)
                props.setZoomHours(nextZoom)
                props.setViewStartHour(clampViewStart(nextStartHour, nextZoom))
              }}
            />

            <div className="timeline-snapshot-grid" role="list" aria-label="窗口摘要">
              <article className="timeline-snapshot-card" role="listitem">
                <span>窗口时长</span>
                <strong>{formatDuration(windowDurationSec)}</strong>
                <small>{windowLabel}</small>
              </article>
              <article className="timeline-snapshot-card" role="listitem">
                <span>窗口覆盖</span>
                <strong>{formatPercent(focusCoverageRatio)}</strong>
                <small>应用记录 {formatDuration(focusDurationSec)}</small>
              </article>
              <article className="timeline-snapshot-card" role="listitem">
                <span>活跃占比</span>
                <strong>{formatPercent(activeRatio)}</strong>
                <small>状态活跃 {formatDuration(activeDurationSec)}</small>
              </article>
              <article className="timeline-snapshot-card" role="listitem">
                <span>应用与连续</span>
                <strong>{visibleAppCount} / {formatDuration(longestVisibleDurationSec)}</strong>
                <small>窗口内应用数 / 最长片段</small>
              </article>
            </div>

          </div>
        </div>

        <div className="page-content-side">
          <div className="panel page-panel browser-detail-panel">
            <div className="panel-header">
              <div>
                <h2>事件列表</h2>
              </div>
              <div className="timeline-header-meta">
                <span className="timeline-meta-pill">窗口内 {visibleFocusItems.length}</span>
              </div>
            </div>

            <div className="detail-list-section">
              <div className="detail-list-meta">
                <span>当前窗口</span>
                <strong>{visibleFocusItems.length}</strong>
              </div>
              <div className="detail-segment-scroll">
                <FocusSegmentList
                  segments={visibleFocusItems}
                  browserDomainBySegmentId={browserDomainBySegmentId}
                  hoveredSegmentId={hoveredFocusSegmentId}
                  onHoverSegment={setHoveredFocusSegmentId}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function SettingsPage(props: {
  agentSettings: AgentSettingsResponse | null
  error: string | null
  settingsError: string | null
  settingsNotice: string | null
  lastUpdatedAt: string | null
  selectedDate: string
  timezone: string
  savingAutostart: boolean
  savingConfig: boolean
  isSettingsRefreshing: boolean
  onToggleAutostart: (enabled: boolean) => Promise<void>
  onUpdateConfig: (payload: {
    idle_threshold_secs: number
    poll_interval_millis: number
    record_window_titles: boolean
    record_page_titles: boolean
    ignored_apps: string[]
    ignored_domains: string[]
  }) => Promise<void>
}) {
  const [idleThresholdSecs, setIdleThresholdSecs] = useState(60)
  const [pollIntervalMillis, setPollIntervalMillis] = useState(1000)
  const [recordWindowTitles, setRecordWindowTitles] = useState(true)
  const [recordPageTitles, setRecordPageTitles] = useState(true)
  const [ignoredAppsText, setIgnoredAppsText] = useState('')
  const [ignoredDomainsText, setIgnoredDomainsText] = useState('')

  useEffect(() => {
    if (!props.agentSettings) {
      return
    }

    setIdleThresholdSecs(props.agentSettings.idle_threshold_secs)
    setPollIntervalMillis(props.agentSettings.poll_interval_millis)
    setRecordWindowTitles(props.agentSettings.record_window_titles)
    setRecordPageTitles(props.agentSettings.record_page_titles)
    setIgnoredAppsText(props.agentSettings.ignored_apps.join('\n'))
    setIgnoredDomainsText(props.agentSettings.ignored_domains.join('\n'))
  }, [props.agentSettings])

  async function handleSaveConfig() {
    await props.onUpdateConfig({
      idle_threshold_secs: clampNumber(Math.round(idleThresholdSecs), 15, 1800),
      poll_interval_millis: clampNumber(Math.round(pollIntervalMillis), 250, 5000),
      record_window_titles: recordWindowTitles,
      record_page_titles: recordPageTitles,
      ignored_apps: parseConfigList(ignoredAppsText),
      ignored_domains: parseConfigList(ignoredDomainsText),
    })
  }

  return (
    <section className="page-stack">
      <div className="page-content-layout">
        <div className="page-content-main page-card-stack">
          <div className="panel page-panel settings-card">
            <div className="panel-header">
              <div>
                <p className="section-kicker">服务</p>
                <h2>本地服务</h2>
              </div>
              <RefreshBadge active={props.isSettingsRefreshing} />
            </div>
            <dl className="settings-list">
              <div>
                <dt>接口地址</dt>
                <dd>{API_BASE_URL}</dd>
              </div>
              <div>
                <dt>前端地址</dt>
                <dd>{props.agentSettings?.web_ui_url ?? '--'}</dd>
              </div>
              <div>
                <dt>连接状态</dt>
                <dd>{props.error ? '离线' : '在线'}</dd>
              </div>
              <div>
                <dt>最后更新</dt>
                <dd>{props.lastUpdatedAt ?? '等待连接'}</dd>
              </div>
              <div>
                <dt>启动命令</dt>
                <dd>{props.agentSettings?.launch_command ?? '--'}</dd>
              </div>
            </dl>
          </div>

          <div className="panel page-panel settings-card">
            <p className="section-kicker">启动</p>
            <h2>启动与采集配置</h2>
            <dl className="settings-list">
              <div>
                <dt>开机自启动</dt>
                <dd>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={props.agentSettings?.autostart_enabled ?? false}
                    aria-label="开机自启动"
                    className={`toggle-switch ${props.agentSettings?.autostart_enabled ? 'is-active' : ''}`}
                    disabled={props.savingAutostart}
                    onClick={() => {
                      void props.onToggleAutostart(!(props.agentSettings?.autostart_enabled ?? false))
                    }}
                  >
                    <span className="toggle-switch-track" aria-hidden="true">
                      <span className="toggle-switch-thumb" />
                    </span>
                    <span className="toggle-switch-text">
                      {props.savingAutostart
                        ? '保存中…'
                        : props.agentSettings?.autostart_enabled
                          ? '已启用'
                          : '已禁用'}
                    </span>
                  </button>
                </dd>
              </div>
              <div>
                <dt>托盘菜单</dt>
                <dd>{props.agentSettings?.tray_enabled ? '已启用' : '已禁用'}</dd>
              </div>
              <div>
                <dt>日期</dt>
                <dd>{props.selectedDate}</dd>
              </div>
              <div>
                <dt>时区</dt>
                <dd>{props.timezone}</dd>
              </div>
            </dl>

            <div className="settings-config-grid" role="group" aria-label="采集阈值和过滤设置">
              <label className="settings-config-field">
                <span>空闲阈值（秒）</span>
                <input
                  type="number"
                  min={15}
                  max={1800}
                  step={5}
                  value={idleThresholdSecs}
                  onChange={(event) => setIdleThresholdSecs(Number(event.target.value) || 0)}
                />
              </label>

              <label className="settings-config-field">
                <span>轮询间隔（毫秒）</span>
                <input
                  type="number"
                  min={250}
                  max={5000}
                  step={50}
                  value={pollIntervalMillis}
                  onChange={(event) => setPollIntervalMillis(Number(event.target.value) || 0)}
                />
              </label>

              <label className="settings-config-check">
                <input
                  type="checkbox"
                  checked={recordWindowTitles}
                  onChange={(event) => setRecordWindowTitles(event.target.checked)}
                />
                记录窗口标题
              </label>

              <label className="settings-config-check">
                <input
                  type="checkbox"
                  checked={recordPageTitles}
                  onChange={(event) => setRecordPageTitles(event.target.checked)}
                />
                记录页面标题
              </label>

              <label className="settings-config-field is-wide">
                <span>忽略应用（每行一个，如 chrome.exe）</span>
                <textarea
                  rows={4}
                  value={ignoredAppsText}
                  onChange={(event) => setIgnoredAppsText(event.target.value)}
                />
              </label>

              <label className="settings-config-field is-wide">
                <span>忽略域名（每行一个，如 example.com）</span>
                <textarea
                  rows={4}
                  value={ignoredDomainsText}
                  onChange={(event) => setIgnoredDomainsText(event.target.value)}
                />
              </label>

              <div className="settings-config-actions">
                <button
                  type="button"
                  className="settings-save-button"
                  disabled={props.savingConfig}
                  onClick={() => {
                    void handleSaveConfig()
                  }}
                >
                  {props.savingConfig ? '保存中…' : '保存采集配置'}
                </button>
              </div>
            </div>

            {props.settingsError ? <div className="settings-error">{props.settingsError}</div> : null}
            {props.settingsNotice ? <div className="settings-notice">{props.settingsNotice}</div> : null}
          </div>
        </div>

        <div className="page-content-side">
          <div className="panel page-panel settings-card settings-monitor-card">
            <p className="section-kicker">监视器</p>
            <h2>监视器状态</h2>
            <div className="monitor-list">
              {props.agentSettings?.monitors.map((monitor) => (
                <article key={monitor.key} className="monitor-card">
                  <div className="monitor-head">
                    <strong>{monitor.label}</strong>
                    <span className={`monitor-badge is-${monitor.status}`}>{monitor.status}</span>
                  </div>
                  <p>{monitor.detail}</p>
                  <small>
                    {monitor.last_seen ? `最后活跃 ${new Date(monitor.last_seen).toLocaleTimeString()}` : '等待首次心跳'}
                  </small>
                </article>
              )) ?? <div className="empty-card">读取中…</div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const FocusSegmentList = memo(function FocusSegmentList(props: {
  segments: ChartSegment[]
  browserDomainBySegmentId: Map<string, string>
  hoveredSegmentId: string | null
  onHoverSegment: (segmentId: string | null) => void
}) {
  if (props.segments.length === 0) {
    return <div className="empty-card">暂无记录</div>
  }

  return (
    <div className="detail-segment-list">
      {props.segments.map((segment) => {
        return (
          <article
            key={segment.id}
            className={`detail-segment-item ${props.hoveredSegmentId === segment.id ? 'is-hovered' : ''}`}
            title={`${segment.label}\n${formatClockRange(segment.startSec, segment.endSec)}`}
            onMouseEnter={() => props.onHoverSegment(segment.id)}
            onMouseLeave={() => props.onHoverSegment(null)}
          >
            <span className="detail-segment-row">
              <span className="detail-segment-name">
                <i style={{ backgroundColor: segment.color }} />
                {segment.label}
              </span>
              {segment.isBrowser ? (
                <span className="detail-segment-domain">
                  {props.browserDomainBySegmentId.get(segment.id) ?? ''}
                </span>
              ) : null}
            </span>
            <span className="detail-segment-time">
              {formatClockRange(segment.startSec, segment.endSec)}
            </span>
          </article>
        )
      })}
    </div>
  )
})

function LoadingState() {
  return <div className="state-card">加载中…</div>
}

function ErrorState(props: { error: string }) {
  return <div className="state-card error-card">{props.error}</div>
}

function InlineErrorState(props: { error: string }) {
  return <div className="inline-error-banner">{props.error}</div>
}

function RefreshBadge(props: { active: boolean }) {
  void props
  return null
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

function sumSlices(slices: DonutSlice[]) {
  return slices.reduce((sum, slice) => sum + slice.value, 0)
}

function defaultTimelineViewport(
  date: string,
  agentToday: string | null,
  timezone: string | null,
) {
  const zoomHours = 0.5

  if (agentToday !== null && date === agentToday) {
    const currentHour = currentHourInTimezone(timezone)
    return {
      zoomHours,
      viewStartHour: clampViewStart(currentHour - zoomHours, zoomHours),
    }
  }

  return {
    zoomHours,
    viewStartHour: 0,
  }
}

function formatHourLabel(hours: number) {
  const totalMinutes = Math.round(hours * 60)
  const normalizedMinutes = Math.max(0, totalMinutes)
  const whole = Math.floor(normalizedMinutes / 60)
  const minutes = normalizedMinutes % 60
  return `${`${whole}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`
}

function clampViewStart(startHour: number, zoomHours: number) {
  return Math.max(0, Math.min(startHour, 24 - zoomHours))
}

function normalizeZoomHours(hours: number) {
  return Math.round(hours * 60) / 60
}

function clampZoomHours(hours: number) {
  return Math.max(MIN_ZOOM_HOURS, Math.min(hours, MAX_ZOOM_HOURS))
}

function monthFromDate(date: string) {
  return date.slice(0, 7)
}

function coerceDateIntoMonth(month: string, baseDate: string) {
  const [yearText, monthText] = month.split('-')
  const preferredDay = Number(baseDate.slice(8, 10)) || 1
  const clampedDay = Math.min(preferredDay, daysInMonth(Number(yearText), Number(monthText)))
  return `${yearText}-${monthText}-${String(clampedDay).padStart(2, '0')}`
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function buildWeekSeries(days: DaySummary[], selectedDate: string): WeekBarDatum[] {
  const dayMap = new Map(days.map((day) => [day.date, day]))
  const selected = parseDateString(selectedDate)
  const weekday = (selected.getUTCDay() + 6) % 7
  const monday = addDays(selected, -weekday)

  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(monday, index)
    const dateKey = formatDateKey(date)
    const summary = dayMap.get(dateKey)

    return {
      date: dateKey,
      dayLabel: `${formatWeekday(date)} ${String(date.getUTCDate()).padStart(2, '0')}`,
      activeSeconds: summary?.active_seconds ?? 0,
      focusSeconds: summary?.focus_seconds ?? 0,
      isSelected: dateKey === selectedDate,
    }
  })
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function overlapDuration(segment: ChartSegment, viewStartSec: number, viewEndSec: number) {
  return Math.max(0, Math.min(segment.endSec, viewEndSec) - Math.max(segment.startSec, viewStartSec))
}

function sumOverlappedDuration(
  segments: ChartSegment[],
  viewStartSec: number,
  viewEndSec: number,
) {
  return segments.reduce(
    (total, segment) => total + overlapDuration(segment, viewStartSec, viewEndSec),
    0,
  )
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function niceWeeklyAxisMax(seconds: number) {
  const hours = seconds / 3600

  if (hours <= 2) {
    return 2 * 3600
  }
  if (hours <= 4) {
    return 4 * 3600
  }
  if (hours <= 6) {
    return 6 * 3600
  }
  if (hours <= 8) {
    return 8 * 3600
  }

  return Math.ceil(hours / 4) * 4 * 3600
}

function formatWeeklyAxisTick(seconds: number) {
  return `${Math.round(seconds / 3600)} 小时`
}

function buildVisibleFocusItems(
  segments: ChartSegment[],
  viewStartSec: number,
  viewEndSec: number,
) {
  return segments
    .filter((segment) => segment.endSec > viewStartSec && segment.startSec < viewEndSec)
    .sort((left, right) => {
      if (left.startSec !== right.startSec) {
        return left.startSec - right.startSec
      }

      return right.durationSec - left.durationSec
    })
}

function buildPrimaryBrowserDomainMap(
  focusSegments: ChartSegment[],
  browserSegments: ChartSegment[],
) {
  const domainBySegmentId = new Map<string, string>()

  for (const focusSegment of focusSegments) {
    if (!focusSegment.isBrowser) {
      continue
    }

    const domainDurations = new Map<string, number>()

    for (const browserSegment of browserSegments) {
      const overlapStart = Math.max(focusSegment.startSec, browserSegment.startSec)
      const overlapEnd = Math.min(focusSegment.endSec, browserSegment.endSec)

      if (overlapEnd <= overlapStart) {
        continue
      }

      domainDurations.set(
        browserSegment.label,
        (domainDurations.get(browserSegment.label) ?? 0) + (overlapEnd - overlapStart),
      )
    }

    const primaryDomain = Array.from(domainDurations.entries())
      .sort((left, right) => right[1] - left[1])[0]?.[0]

    if (primaryDomain) {
      domainBySegmentId.set(focusSegment.id, primaryDomain)
    }
  }

  return domainBySegmentId
}

function currentHourInTimezone(timezone: string | null) {
  const offsetMinutes = parseUtcOffsetMinutes(timezone)
  if (offsetMinutes === null) {
    const now = new Date()
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
  }

  const shifted = new Date(Date.now() + offsetMinutes * 60_000)
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600
}

function parseUtcOffsetMinutes(value: string | null) {
  if (!value || value === 'Z') {
    return value === 'Z' ? 0 : null
  }

  const match = value.match(/^([+-])(\d{2}):(\d{2})$/)
  if (!match) {
    return null
  }

  const [, sign, hours, minutes] = match
  const total = Number(hours) * 60 + Number(minutes)
  return sign === '-' ? -total : total
}

function parseDateString(value: string) {
  return new Date(`${value}T00:00:00Z`)
}

function addDays(date: Date, offset: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + offset)
  return next
}

function formatDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function formatWeekday(date: Date) {
  return ['一', '二', '三', '四', '五', '六', '日'][(date.getUTCDay() + 6) % 7]
}

function parseConfigList(value: string) {
  const unique = new Set<string>()

  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .forEach((item) => {
      unique.add(item)
    })

  return Array.from(unique.values())
}

export default App
