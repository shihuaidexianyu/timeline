/* ActivityWatch-inspired multi-page dashboard for stats, timeline, and settings. */

import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  API_BASE_URL,
  getAgentSettings,
  getMonthCalendar,
  getPeriodSummary,
  getTimeline,
  updateAutostart,
  type AgentSettingsResponse,
  type DaySummary,
  type MonthCalendarResponse,
  type PeriodSummaryResponse,
  type TimelineDayResponse,
} from './api'
import { CalendarGrid } from './components/calendar-grid'
import { CompactDonutChart, DonutChart } from './components/donut-chart'
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
  const [savingAutostart, setSavingAutostart] = useState(false)
  const activeOnly = false
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [selectedFocusSegmentId, setSelectedFocusSegmentId] = useState<string | null>(null)
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

  const selectedFocusSegment = useMemo(() => {
    if (!dashboard || !selectedFocusSegmentId) {
      return null
    }

    return (
      dashboard.focusSegments.find((segment) => segment.id === selectedFocusSegmentId) ?? null
    )
  }, [dashboard, selectedFocusSegmentId])

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
      setSelectedFocusSegmentId(null)
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
      setSelectedFocusSegmentId(null)
      setDomainFilter(null)
      setZoomHours(nextWindow.zoomHours)
      setViewStartHour(nextWindow.viewStartHour)
    })
  }

  return (
    <main className="app-shell app-layout">
      <aside className="sidebar-shell">
        <div className="sidebar-brand">
          <p className="eyebrow">TimeLine</p>
          <h1>个人活动</h1>
          <p className="sidebar-text">记录您的日常活动，明白时间都去了哪里。</p>
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
                selectedFocusSegmentId={selectedFocusSegmentId}
                selectedFocusSegment={selectedFocusSegment}
                viewStartHour={viewStartHour}
                viewStartSec={viewStartSec}
                viewEndSec={viewEndSec}
                zoomHours={zoomHours}
                isTimelineRefreshing={isTimelineRefreshing}
                setAppFilter={setAppFilter}
                setZoomHours={setZoomHours}
                setViewStartHour={setViewStartHour}
                setSelectedFocusSegmentId={setSelectedFocusSegmentId}
                setDomainFilter={setDomainFilter}
              />
            ) : null}

            {page === 'settings' ? (
              <SettingsPage
                agentSettings={agentSettings}
                error={error}
                settingsError={settingsError}
                lastUpdatedAt={lastUpdatedAt}
                selectedDate={resolvedSelectedDate}
                timezone={agentTimezone ?? timeline?.timezone ?? '--'}
                savingAutostart={savingAutostart}
                isSettingsRefreshing={isSettingsRefreshing}
                onToggleAutostart={async (enabled) => {
                  setSavingAutostart(true)
                  setSettingsError(null)

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
  const topApps = props.dashboard.appSlices.filter((slice) => slice.key !== 'others').slice(0, 5)
  const presenceByKey = new Map(
    props.dashboard.presenceSlices.map((slice) => [slice.key, slice.value]),
  )
  const isCurrentDate = props.agentToday !== null && props.selectedDate === props.agentToday

  return (
    <section className="page-stack">
      <section className="stats-overview-grid">
        <WeeklyRhythmCard
          periodSummary={props.periodSummary}
          weekBars={weekBars}
          topApps={topApps}
          isCurrentDate={isCurrentDate}
          appFilter={props.appFilter}
          refreshing={props.isPeriodRefreshing}
          onSelectApp={props.setAppFilter}
          onSelectDate={props.onSelectDate}
        />
        <FocusBalanceCard
          dashboard={props.dashboard}
          activeSeconds={presenceByKey.get('active') ?? 0}
          idleSeconds={presenceByKey.get('idle') ?? 0}
          lockedSeconds={presenceByKey.get('locked') ?? 0}
          isCurrentDate={isCurrentDate}
          refreshing={props.isTimelineRefreshing}
        />
      </section>

      <section className="stats-analysis-grid">
        <div className="panel page-panel stats-analysis-card">
          <div className="panel-header">
            <div>
              <p className="section-kicker">分析</p>
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
              <p className="section-kicker">分析</p>
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
              <p className="section-kicker">月度热力图</p>
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
            <div className="state-card">正在加载该月份的汇总日历…</div>
          )}
        </div>
      </section>
    </section>
  )
}

function WeeklyRhythmCard(props: {
  periodSummary: PeriodSummaryResponse | null
  weekBars: WeekBarDatum[]
  topApps: DonutSlice[]
  isCurrentDate: boolean
  appFilter: DashboardFilter
  refreshing: boolean
  onSelectApp: (value: DashboardFilter) => void
  onSelectDate: (date: string) => void
}) {
  const [selectedMetric, setSelectedMetric] = useState<'active' | 'focus'>('active')
  const selectedBar = props.weekBars.find((bar) => bar.isSelected) ?? props.weekBars[props.weekBars.length - 1]
  const weekTotal =
    selectedMetric === 'active'
      ? props.periodSummary?.week.active_seconds ?? 0
      : props.periodSummary?.week.focus_seconds ?? 0
  const monthTotal =
    selectedMetric === 'active'
      ? props.periodSummary?.month.active_seconds ?? 0
      : props.periodSummary?.month.focus_seconds ?? 0
  const selectedDayValue =
    selectedMetric === 'active'
      ? selectedBar?.activeSeconds ?? 0
      : selectedBar?.focusSeconds ?? 0

  return (
    <article className="showcase-card showcase-card-dashboard">
      <div className="showcase-card-head">
        <div>
          <p className="section-kicker">周趋势</p>
          <h2>{props.isCurrentDate ? '本周节奏' : '所在周节奏'}</h2>
        </div>
        <div className="card-head-side">
          <RefreshBadge active={props.refreshing} />
          <div className="showcase-chip-row">
            <button
              type="button"
              className={`showcase-chip-button ${selectedMetric === 'active' ? 'is-selected' : ''}`}
              onClick={() => setSelectedMetric('active')}
            >
              活跃
            </button>
            <button
              type="button"
              className={`showcase-chip-button ${selectedMetric === 'focus' ? 'is-selected' : ''}`}
              onClick={() => setSelectedMetric('focus')}
            >
              应用
            </button>
          </div>
        </div>
      </div>

      <div className="weekly-summary-row">
        <div>
          <strong>{formatDuration(weekTotal)}</strong>
          <small>{selectedMetric === 'active' ? '本周活跃' : '本周应用'}</small>
        </div>
        <div>
          <strong>{formatDuration(monthTotal)}</strong>
          <small>{selectedMetric === 'active' ? '当月活跃' : '当月应用'}</small>
        </div>
      </div>

      <WeeklyBarChart
        bars={props.weekBars}
        metric={selectedMetric}
        onSelectDate={props.onSelectDate}
      />

      {selectedBar ? (
        <div className="weekly-selection-note">
          <strong>{selectedBar.dayLabel}</strong>
          <span>
            {selectedMetric === 'active' ? '活跃' : '应用'} {formatDuration(selectedDayValue)}
          </span>
          <small>点击柱子切换日期</small>
        </div>
      ) : null}

      <div className="mini-list-card">
        <div className="mini-list-head">
          <span>重点查看</span>
          <strong>应用排行</strong>
        </div>
        <div className="mini-usage-list">
          {props.topApps.length === 0 ? (
            <div className="empty-card">所选日期没有应用记录</div>
          ) : (
            props.topApps.map((slice) => (
              <button
                key={slice.id}
                type="button"
                className={`mini-usage-row ${props.appFilter?.kind === 'app' && props.appFilter.key === slice.key ? 'is-selected' : ''}`}
                onClick={() => {
                  props.onSelectApp(
                    props.appFilter?.kind === 'app' && props.appFilter.key === slice.key
                      ? null
                      : { kind: 'app', key: slice.key },
                  )
                }}
              >
                <span className="mini-usage-name">
                  <i style={{ backgroundColor: slice.color }} />
                  {slice.label}
                </span>
                <span>{formatDuration(slice.value)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </article>
  )
}

function FocusBalanceCard(props: {
  dashboard: DashboardModel
  activeSeconds: number
  idleSeconds: number
  lockedSeconds: number
  isCurrentDate: boolean
  refreshing: boolean
}) {
  const activeRatio =
    props.dashboard.summary.focusSeconds > 0
      ? props.dashboard.summary.activeSeconds / props.dashboard.summary.focusSeconds
      : 0
  const appCount = props.dashboard.appSlices.filter((slice) => slice.key !== 'others').length
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
          <p className="section-kicker">状态平衡</p>
          <h2>{props.isCurrentDate ? '今天状态分布' : '当日状态分布'}</h2>
        </div>
        <RefreshBadge active={props.refreshing} />
      </div>

      <p className="focus-card-copy">
        用状态环对照活跃、空闲和锁定，把当天的专注效率和使用节奏放在同一视图里。
      </p>

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

      <div className="focus-footnote">{appCount} 个应用被记录</div>

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

      <div className="presence-strip">
        <button
          type="button"
          className={`presence-pill ${selectedPresenceKey === 'active' ? 'is-selected' : ''}`}
          onClick={() => setSelectedPresenceKey('active')}
        >
          活跃 {formatDuration(props.activeSeconds)}
        </button>
        <button
          type="button"
          className={`presence-pill ${selectedPresenceKey === 'idle' ? 'is-selected' : ''}`}
          onClick={() => setSelectedPresenceKey('idle')}
        >
          空闲 {formatDuration(props.idleSeconds)}
        </button>
        <button
          type="button"
          className={`presence-pill ${selectedPresenceKey === 'locked' ? 'is-selected' : ''}`}
          onClick={() => setSelectedPresenceKey('locked')}
        >
          锁定 {formatDuration(props.lockedSeconds)}
        </button>
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
  metric: 'active' | 'focus'
  onSelectDate: (date: string) => void
}) {
  const maxValue = Math.max(
    ...props.bars.map((bar) =>
      props.metric === 'active' ? bar.activeSeconds : bar.focusSeconds,
    ),
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
            const value =
              props.metric === 'active' ? bar.activeSeconds : bar.focusSeconds
            const barHeight = `${Math.max((value / axisMaxValue) * 100, value > 0 ? 10 : 0)}%`
            const valueLabel = formatDuration(value)

            return (
              <button
                key={bar.date}
                type="button"
                className={`weekly-bar-column ${bar.isSelected ? 'is-selected' : ''} is-${props.metric}`}
                onClick={() => props.onSelectDate(bar.date)}
                title={`${bar.date} ${props.metric === 'active' ? '活跃' : '应用'} ${valueLabel}`}
              >
                <div className="weekly-bar-track">
                  <div className="weekly-bar" style={{ height: barHeight }} />
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
  selectedFocusSegmentId: string | null
  selectedFocusSegment: DashboardModel['focusSegments'][number] | null
  viewStartHour: number
  viewStartSec: number
  viewEndSec: number
  zoomHours: number
  isTimelineRefreshing: boolean
  setAppFilter: (value: DashboardFilter) => void
  setZoomHours: (hours: number) => void
  setViewStartHour: (hours: number) => void
  setSelectedFocusSegmentId: (value: string | null | ((current: string | null) => string | null)) => void
  setDomainFilter: (value: DashboardFilter) => void
}) {
  const selectedFocusSegment = props.selectedFocusSegment
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
  const zoomPresets = [0.25, 0.5, 1, 4]

  function applyWindow(nextZoomHours: number, nextStartHour: number) {
    props.setZoomHours(nextZoomHours)
    props.setViewStartHour(clampViewStart(normalizeZoomHours(nextStartHour), nextZoomHours))
  }

  function centerOnSelectedSegment() {
    if (!selectedFocusSegment) {
      return
    }

    const nextZoom = clampZoomHours(
      Math.max(
        normalizeZoomHours((selectedFocusSegment.durationSec / 3600) * 1.6),
        MIN_ZOOM_HOURS,
      ),
    )
    const segmentMidpoint =
      selectedFocusSegment.startSec + selectedFocusSegment.durationSec / 2
    const nextStart = clampViewStart(segmentMidpoint / 3600 - nextZoom / 2, nextZoom)

    applyWindow(nextZoom, nextStart)
  }

  function handleSelectFocusSegment(segment: ChartSegment) {
    props.setSelectedFocusSegmentId((current) => (current === segment.id ? null : segment.id))
    props.setDomainFilter(null)
  }

  return (
    <section className="page-stack">
      <div className="page-content-layout timeline-page-layout">
        <div className="page-content-main">
          <div className="panel page-panel timeline-panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">时间线</p>
                <h2>应用时间线</h2>
              </div>
              <div className="timeline-panel-actions">
                <RefreshBadge active={props.isTimelineRefreshing} />
                <p className="timezone-label">
                  当前窗口 {formatHourLabel(props.viewStartHour)} -{' '}
                  {formatHourLabel(props.viewStartHour + props.zoomHours)}
                </p>
              </div>
            </div>

            <div className="timeline-control-bar">
              <div className="timeline-control-group">
                <span className="timeline-control-label">缩放</span>
                {zoomPresets.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`timeline-control-button ${Math.abs(props.zoomHours - preset) < 0.001 ? 'is-active' : ''
                      }`}
                    onClick={() => {
                      const centerHour = props.viewStartHour + props.zoomHours / 2
                      applyWindow(preset, centerHour - preset / 2)
                    }}
                  >
                    {formatZoomPreset(preset)}
                  </button>
                ))}
              </div>

              <div className="timeline-control-group">
                <span className="timeline-control-label">窗口</span>
                <button
                  type="button"
                  className="timeline-control-button"
                  onClick={() => applyWindow(props.zoomHours, props.viewStartHour - props.zoomHours / 2)}
                >
                  向前
                </button>
                <button
                  type="button"
                  className="timeline-control-button"
                  onClick={() => applyWindow(props.zoomHours, 0)}
                >
                  回到起点
                </button>
                <button
                  type="button"
                  className="timeline-control-button"
                  onClick={() => applyWindow(props.zoomHours, props.viewStartHour + props.zoomHours / 2)}
                >
                  向后
                </button>
                {selectedFocusSegment ? (
                  <button
                    type="button"
                    className="timeline-control-button"
                    onClick={centerOnSelectedSegment}
                  >
                    定位到选中段
                  </button>
                ) : null}
              </div>
            </div>

            <TimelineChart
              rows={[
                {
                  id: 'focus-overview',
                  label: '应用总览',
                  segments: props.dashboard.focusSegments,
                  selectedKey: props.appFilter?.key ?? null,
                  splitByKey: false,
                  includeInOverview: false,
                  includeInTable: false,
                },
                {
                  id: 'focus',
                  label: '应用',
                  segments: props.dashboard.focusSegments,
                  selectedKey: props.appFilter?.key ?? null,
                },
                {
                  id: 'presence',
                  label: '状态',
                  segments: props.dashboard.presenceSegments,
                  includeInTable: false,
                },
              ]}
              viewStartSec={props.viewStartSec}
              viewEndSec={props.viewEndSec}
              baseDate={props.selectedDate}
              interactiveZoom
              minViewHours={MIN_ZOOM_HOURS}
              maxViewHours={MAX_ZOOM_HOURS}
              selectedSegmentId={props.selectedFocusSegmentId}
              onViewportChange={(nextStartSec, nextEndSec) => {
                const nextZoom = clampZoomHours(
                  normalizeZoomHours((nextEndSec - nextStartSec) / 3600),
                )
                const nextStartHour = normalizeZoomHours(nextStartSec / 3600)
                props.setZoomHours(nextZoom)
                props.setViewStartHour(clampViewStart(nextStartHour, nextZoom))
              }}
              onSelectSegment={(segment) => {
                if (segment.tone !== 'focus') {
                  return
                }

                handleSelectFocusSegment(segment)
              }}
            />
          </div>
        </div>

        <div className="page-content-side">
          <div className="panel page-panel browser-detail-panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">明细</p>
                <h2>进程</h2>
              </div>
              <div className="timeline-panel-actions">
                <RefreshBadge active={props.isTimelineRefreshing} />
              </div>
            </div>

            <div className="browser-detail-summary">
              {selectedFocusSegment ? (
                <div className="detail-current-card">
                  <strong>{selectedFocusSegment.label}</strong>
                  <span>
                    {formatClockRange(
                      selectedFocusSegment.startSec,
                      selectedFocusSegment.endSec,
                    )}
                  </span>
                </div>
              ) : (
                <div className="detail-empty-state">
                  <strong>未选择</strong>
                  <span>点击左侧任意一段</span>
                </div>
              )}
            </div>

            <div className="detail-list-section">
              <div className="detail-segment-scroll">
                <FocusSegmentList
                  segments={visibleFocusItems}
                  browserDomainBySegmentId={browserDomainBySegmentId}
                  selectedSegmentId={props.selectedFocusSegmentId}
                  onSelectSegment={handleSelectFocusSegment}
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
  lastUpdatedAt: string | null
  selectedDate: string
  timezone: string
  savingAutostart: boolean
  isSettingsRefreshing: boolean
  onToggleAutostart: (enabled: boolean) => Promise<void>
}) {
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
            <h2>启动与当前视图</h2>
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

            {props.settingsError ? <div className="settings-error">{props.settingsError}</div> : null}
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
              )) ?? <div className="empty-card">正在读取监视器状态…</div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function FocusSegmentList(props: {
  segments: ChartSegment[]
  browserDomainBySegmentId: Map<string, string>
  selectedSegmentId: string | null
  onSelectSegment: (segment: ChartSegment) => void
}) {
  if (props.segments.length === 0) {
    return <div className="empty-card">当前窗口内没有应用段记录</div>
  }

  return (
    <div className="detail-segment-list">
      {props.segments.map((segment) => {
        const isSelected = props.selectedSegmentId === segment.id

        return (
          <button
            key={segment.id}
            type="button"
            className={`detail-segment-item ${isSelected ? 'is-selected' : ''}`}
            onClick={() => props.onSelectSegment(segment)}
            title={`${segment.label}\n${formatClockRange(segment.startSec, segment.endSec)}`}
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
          </button>
        )
      })}
    </div>
  )
}

function LoadingState() {
  return <div className="state-card">正在从本地服务读取图表数据…</div>
}

function ErrorState(props: { error: string }) {
  return <div className="state-card error-card">{props.error}</div>
}

function InlineErrorState(props: { error: string }) {
  return <div className="inline-error-banner">{props.error}</div>
}

function RefreshBadge(props: { active: boolean }) {
  return props.active ? <span className="refresh-badge">更新中</span> : null
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
      title: '应用时间线',
      description: '先用显式缩放和窗口控制定位，再查看浏览器应用内部的域名明细。',
    }
  }

  if (page === 'settings') {
    return {
      kicker: '设置',
      title: '本地设置',
      description: '查看当前连接、本地采集范围和当前视图参数。',
    }
  }

  return {
    kicker: '统计',
    title: '统计概览',
    description: '先看当日概览，再进入应用分布、域名分布和月度回看。',
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
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
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

function formatZoomPreset(hours: number) {
  if (hours < 1) {
    return `${Math.round(hours * 60)} 分钟`
  }

  return `${hours} 小时`
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

export default App
