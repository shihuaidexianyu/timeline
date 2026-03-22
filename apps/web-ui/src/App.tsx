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
  buildBrowserDetailModel,
  buildDashboardModel,
  formatClockRange,
  formatDuration,
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savingAutostart, setSavingAutostart] = useState(false)
  const activeOnly = false
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [selectedBrowserSegmentId, setSelectedBrowserSegmentId] = useState<string | null>(null)
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
      setLoading(true)
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
          setLoading(false)
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
      setLoading(true)
      setError(null)

      try {
        const [nextTimeline, nextSettings, nextPeriod] = await Promise.all([
          getTimeline(currentDate),
          getAgentSettings(),
          getPeriodSummary(currentDate),
        ])
        if (cancelled) {
          return
        }

        setTimeline(nextTimeline)
        setAgentSettings(nextSettings)
        setPeriodSummary(nextPeriod)
        setAgentTimezone(nextTimeline.timezone)
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
          setLoading(false)
        }
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
    setMonthCalendar(null)

    void getMonthCalendar(calendarMonth)
      .then((data) => {
        if (!cancelled) {
          setMonthCalendar(data)
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          const message =
            loadError instanceof Error ? loadError.message : '加载月历数据时发生未知错误'
          setCalendarError(message)
          setMonthCalendar(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [calendarMonth])

  useEffect(() => {
    setViewStartHour((current) => clampViewStart(current, zoomHours))
  }, [zoomHours])

  const dashboard = timeline ? buildDashboardModel(timeline, activeOnly) : null

  const selectedBrowserSegment = useMemo(() => {
    if (!dashboard || !selectedBrowserSegmentId) {
      return null
    }

    return (
      dashboard.focusSegments.find((segment) => segment.id === selectedBrowserSegmentId) ?? null
    )
  }, [dashboard, selectedBrowserSegmentId])

  const browserDetail = useMemo(() => {
    if (!dashboard) {
      return buildBrowserDetailModel(null, [], null)
    }

    return buildBrowserDetailModel(
      selectedBrowserSegment,
      dashboard.browserSegments,
      domainFilter?.key ?? null,
    )
  }, [dashboard, selectedBrowserSegment, domainFilter])

  const viewStartSec = viewStartHour * 3600
  const viewEndSec = viewStartSec + zoomHours * 3600
  const pageInfo = pageMeta(page)
  const resolvedSelectedDate = selectedDate ?? timeline?.date ?? '--'

  function applySelectedDate(nextDate: string) {
    const nextWindow = defaultTimelineViewport(nextDate, agentToday, agentTimezone)

    startTransition(() => {
      setSelectedDate(nextDate)
      setCalendarMonth(monthFromDate(nextDate))
      setSelectedBrowserSegmentId(null)
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
      setSelectedBrowserSegmentId(null)
      setDomainFilter(null)
      setZoomHours(nextWindow.zoomHours)
      setViewStartHour(nextWindow.viewStartHour)
    })
  }

  return (
    <main className="app-shell app-layout">
      <aside className="sidebar-shell">
        <div className="sidebar-brand">
          <p className="eyebrow">Timeline</p>
          <h1>个人活动</h1>
          <p className="sidebar-text">记录您的日常活动，明白时间都去了哪里。</p>
        </div>

        <nav className="sidebar-nav" aria-label="Pages">
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

        {loading ? <LoadingState /> : null}
        {error ? <ErrorState error={error} /> : null}

        {!loading && !error && dashboard ? (
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
                onCalendarMonthChange={handleCalendarMonthChange}
                onSelectDate={applySelectedDate}
              />
            ) : null}

            {page === 'timeline' ? (
              <TimelinePage
                dashboard={dashboard}
                appFilter={appFilter}
                domainFilter={domainFilter}
                selectedDate={resolvedSelectedDate}
                selectedBrowserSegmentId={selectedBrowserSegmentId}
                selectedBrowserSegment={selectedBrowserSegment}
                browserDetail={browserDetail}
                viewStartHour={viewStartHour}
                viewStartSec={viewStartSec}
                viewEndSec={viewEndSec}
                zoomHours={zoomHours}
                setZoomHours={setZoomHours}
                setViewStartHour={setViewStartHour}
                setSelectedBrowserSegmentId={setSelectedBrowserSegmentId}
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
  onCalendarMonthChange: (month: string) => void
  onSelectDate: (date: string) => void
}) {
  const selectedSummary =
    props.monthCalendar?.days.find((day) => day.date === props.selectedDate) ?? null
  const weekBars = buildWeekSeries(props.monthCalendar?.days ?? [], props.selectedDate)
  const topApps = props.dashboard.appSlices.filter((slice) => slice.key !== 'others').slice(0, 5)
  const topDomains = props.dashboard.domainSlices
    .filter((slice) => slice.key !== 'others')
    .slice(0, 3)
  const presenceByKey = new Map(
    props.dashboard.presenceSlices.map((slice) => [slice.key, slice.value]),
  )
  const isCurrentDate = props.agentToday !== null && props.selectedDate === props.agentToday

  return (
    <section className="page-stack">
      <section className="stats-showcase-grid">
        <DailySnapshotCard
          selectedDate={props.selectedDate}
          selectedSummary={selectedSummary}
          dashboard={props.dashboard}
          topDomains={topDomains}
          appFilter={props.appFilter}
          onSelectApp={props.setAppFilter}
        />
        <WeeklyRhythmCard
          periodSummary={props.periodSummary}
          weekBars={weekBars}
          topApps={topApps}
          isCurrentDate={isCurrentDate}
          appFilter={props.appFilter}
          onSelectApp={props.setAppFilter}
          onSelectDate={props.onSelectDate}
        />
        <FocusBalanceCard
          dashboard={props.dashboard}
          activeSeconds={presenceByKey.get('active') ?? 0}
          idleSeconds={presenceByKey.get('idle') ?? 0}
          lockedSeconds={presenceByKey.get('locked') ?? 0}
          isCurrentDate={isCurrentDate}
        />
      </section>

      <section className="stats-support-grid">
        <div className="page-content-layout">
          <div className="page-content-main">
            <div className="panel page-panel stats-calendar-card">
              <div className="panel-header">
                <div>
                  <p className="section-kicker">Calendar</p>
                  <h2>月度日历</h2>
                </div>
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
          </div>

          <div className="page-content-side stats-side-stack">
            <div className="panel page-panel">
              <DonutChart
                title="应用分布"
                totalLabel={formatDuration(props.dashboard.summary.focusSeconds)}
                slices={props.dashboard.appSlices}
                filter={props.appFilter}
                filterKind="app"
                onSelect={props.setAppFilter}
              />
            </div>

            <div className="panel page-panel">
              <DonutChart
                title="域名分布"
                totalLabel={formatDuration(sumSlices(props.dashboard.domainSlices))}
                slices={props.dashboard.domainSlices}
                filter={props.domainFilter}
                filterKind="domain"
                onSelect={props.setDomainFilter}
              />
            </div>
          </div>
        </div>
      </section>
    </section>
  )
}

function DailySnapshotCard(props: {
  selectedDate: string
  selectedSummary: DaySummary | null
  dashboard: DashboardModel
  topDomains: DonutSlice[]
  appFilter: DashboardFilter
  onSelectApp: (value: DashboardFilter) => void
}) {
  const appSlices = props.dashboard.appSlices.filter((slice) => slice.key !== 'others').slice(0, 4)
  const topApp = appSlices[0] ?? null
  const topDomain = props.topDomains[0] ?? null

  return (
    <article className="showcase-card showcase-card-daily">
      <div className="showcase-card-head">
        <div>
          <p className="section-kicker">Daily Pulse</p>
          <h2>{formatDateHeading(props.selectedDate)}</h2>
        </div>
        <span className="showcase-avatar">{props.selectedDate.slice(8, 10)}</span>
      </div>

      <p className="showcase-copy">围绕所选日期，快速查看活跃时长、切换频率和最常出现的上下文。</p>

      <div className="showcase-donut-wrap">
        <div className="showcase-compact-donut">
          <CompactDonutChart
            slices={appSlices}
            totalLabel={formatDuration(props.dashboard.summary.activeSeconds)}
            secondaryLabel="活跃时长"
            selectedKey={props.appFilter?.kind === 'app' ? props.appFilter.key : null}
            onSelectKey={(key) => {
              props.onSelectApp(
                props.appFilter?.kind === 'app' && props.appFilter.key === key
                  ? null
                  : { kind: 'app', key },
              )
            }}
            height={232}
            emptyLabel="所选日期没有可展示的应用分布"
          />
        </div>
      </div>

      <div className="showcase-stat-grid">
        <div className="showcase-stat-pill">
          <span>应用数</span>
          <strong>{props.dashboard.meta.focusCount}</strong>
        </div>
        <div className="showcase-stat-pill">
          <span>切换次数</span>
          <strong>{props.dashboard.summary.switchCount}</strong>
        </div>
      </div>

      <div className="showcase-tag-list">
        {topApp ? (
          <button
            type="button"
            className={`showcase-tag ${props.appFilter?.kind === 'app' && props.appFilter.key === topApp.key ? 'is-selected' : ''}`}
            onClick={() => {
              props.onSelectApp(
                props.appFilter?.kind === 'app' && props.appFilter.key === topApp.key
                  ? null
                  : { kind: 'app', key: topApp.key },
              )
            }}
          >
            常用应用
            <strong>{topApp.label}</strong>
          </button>
        ) : null}
        {topDomain ? (
          <span className="showcase-tag">
            常用域名
            <strong>{topDomain.label}</strong>
          </span>
        ) : null}
        {props.selectedSummary?.switch_count ? (
          <span className="showcase-tag">
            切换次数
            <strong>{props.selectedSummary.switch_count} 次</strong>
          </span>
        ) : null}
      </div>
    </article>
  )
}

function WeeklyRhythmCard(props: {
  periodSummary: PeriodSummaryResponse | null
  weekBars: WeekBarDatum[]
  topApps: DonutSlice[]
  isCurrentDate: boolean
  appFilter: DashboardFilter
  onSelectApp: (value: DashboardFilter) => void
  onSelectDate: (date: string) => void
}) {
  return (
    <article className="showcase-card showcase-card-dashboard">
      <div className="showcase-card-head">
        <div>
          <p className="section-kicker">Dashboard</p>
          <h2>{props.isCurrentDate ? '本周节奏' : '所在周节奏'}</h2>
        </div>
        <span className="showcase-chip">{props.isCurrentDate ? 'This Week' : 'Selected Week'}</span>
      </div>

      <div className="weekly-summary-row">
        <div>
          <strong>{formatDuration(props.periodSummary?.week.active_seconds ?? 0)}</strong>
          <small>活跃总时长</small>
        </div>
        <div>
          <strong>{formatDuration(props.periodSummary?.month.active_seconds ?? 0)}</strong>
          <small>当月累计</small>
        </div>
      </div>

      <WeeklyBarChart bars={props.weekBars} onSelectDate={props.onSelectDate} />

      <div className="mini-list-card">
        <div className="mini-list-head">
          <span>Most Used</span>
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
          <p className="section-kicker">WorkTime</p>
          <h2>{props.isCurrentDate ? '今天专注' : '当日专注'}</h2>
        </div>
      </div>

      <p className="focus-card-copy">
        用状态环查看活跃、空闲和锁定分布，再和当天的应用时长快速对照。
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

function WeeklyBarChart(props: { bars: WeekBarDatum[]; onSelectDate: (date: string) => void }) {
  const maxFocus = Math.max(...props.bars.map((bar) => bar.focusSeconds), 1)

  return (
    <div className="weekly-bars">
      {props.bars.map((bar) => {
        const focusHeight = `${Math.max((bar.focusSeconds / maxFocus) * 100, bar.focusSeconds > 0 ? 12 : 0)}%`
        const activeHeight = `${Math.max((bar.activeSeconds / maxFocus) * 100, bar.activeSeconds > 0 ? 10 : 0)}%`

        return (
          <button
            key={bar.date}
            type="button"
            className={`weekly-bar-column ${bar.isSelected ? 'is-selected' : ''}`}
            onClick={() => props.onSelectDate(bar.date)}
          >
            <div className="weekly-bar-track">
              <div className="weekly-bar weekly-bar-focus" style={{ height: focusHeight }}>
                <div className="weekly-bar weekly-bar-active" style={{ height: activeHeight }} />
              </div>
            </div>
            <span className="weekly-bar-value">{formatDuration(bar.activeSeconds)}</span>
            <span className="weekly-bar-day">{bar.dayLabel}</span>
          </button>
        )
      })}
    </div>
  )
}

function TimelinePage(props: {
  dashboard: DashboardModel
  appFilter: DashboardFilter
  domainFilter: DashboardFilter
  selectedDate: string
  selectedBrowserSegmentId: string | null
  selectedBrowserSegment: DashboardModel['focusSegments'][number] | null
  browserDetail: ReturnType<typeof buildBrowserDetailModel>
  viewStartHour: number
  viewStartSec: number
  viewEndSec: number
  zoomHours: number
  setZoomHours: (hours: number) => void
  setViewStartHour: (hours: number) => void
  setSelectedBrowserSegmentId: (value: string | null | ((current: string | null) => string | null)) => void
  setDomainFilter: (value: DashboardFilter) => void
}) {
  const selectedBrowserSegment = props.selectedBrowserSegment

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
                <p className="timezone-label">
                  当前窗口 {formatHourLabel(props.viewStartHour)} -{' '}
                  {formatHourLabel(props.viewStartHour + props.zoomHours)}
                </p>
                {selectedBrowserSegment ? (
                  <button
                    type="button"
                    className="zoom-button"
                    onClick={() => {
                      const nextZoom = clampZoomHours(
                        Math.max(
                          normalizeZoomHours((selectedBrowserSegment.durationSec / 3600) * 1.6),
                          MIN_ZOOM_HOURS,
                        ),
                      )
                      const segmentMidpoint =
                        selectedBrowserSegment.startSec + selectedBrowserSegment.durationSec / 2
                      const nextStart = clampViewStart(
                        segmentMidpoint / 3600 - nextZoom / 2,
                        nextZoom,
                      )
                      props.setZoomHours(nextZoom)
                      props.setViewStartHour(nextStart)
                    }}
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
              showTable
              selectedSegmentId={props.selectedBrowserSegmentId}
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

                if (segment.isBrowser) {
                  props.setSelectedBrowserSegmentId((current) =>
                    current === segment.id ? null : segment.id,
                  )
                  props.setDomainFilter(null)
                  return
                }

                props.setSelectedBrowserSegmentId(null)
                props.setDomainFilter(null)
              }}
            />
          </div>
        </div>

        <div className="page-content-side">
          <div className="panel page-panel browser-detail-panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">浏览器</p>
                <h2>浏览器域名明细</h2>
              </div>
              {selectedBrowserSegment ? (
                <p className="timezone-label">
                  {formatClockRange(
                    selectedBrowserSegment.startSec,
                    selectedBrowserSegment.endSec,
                  )}
                </p>
              ) : null}
            </div>

            {selectedBrowserSegment ? (
              <>
                <div className="browser-context">
                  <strong>{selectedBrowserSegment.label}</strong>
                  <span>{selectedBrowserSegment.detail}</span>
                </div>

                <div className="insight-grid browser-detail-layout">
                  <div className="panel panel-subtle browser-summary-panel">
                    <BrowserDomainList
                      slices={props.browserDetail.slices}
                      filter={props.domainFilter}
                      onSelect={props.setDomainFilter}
                      totalLabel={formatDuration(props.browserDetail.totalSeconds)}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-card browser-empty">
                点击主时间线里的浏览器应用段后，这里会显示该时间段内各个域名占用的时间。
              </div>
            )}
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
  onToggleAutostart: (enabled: boolean) => Promise<void>
}) {
  return (
    <section className="page-stack">
      <div className="page-content-layout">
        <div className="page-content-main page-card-stack">
          <div className="panel page-panel settings-card">
            <p className="section-kicker">服务</p>
            <h2>本地服务</h2>
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
                    className={`toggle-button ${props.agentSettings?.autostart_enabled ? 'is-active' : ''}`}
                    disabled={props.savingAutostart}
                    onClick={() => {
                      void props.onToggleAutostart(!(props.agentSettings?.autostart_enabled ?? false))
                    }}
                  >
                    {props.savingAutostart
                      ? '保存中…'
                      : props.agentSettings?.autostart_enabled
                        ? '已启用'
                        : '已禁用'}
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

function BrowserDomainList(props: {
  slices: DonutSlice[]
  filter: DashboardFilter
  onSelect: (value: DashboardFilter) => void
  totalLabel: string
}) {
  return (
    <div className="browser-domain-list">
      <div className="browser-domain-list-head">
        <div>
          <p className="section-kicker">域名</p>
          <h3>域名占比</h3>
        </div>
        <strong>{props.totalLabel}</strong>
      </div>

      <div className="browser-domain-items">
        {props.slices.length === 0 ? (
          <div className="empty-card">当前时间段没有域名数据</div>
        ) : (
          props.slices.map((slice) => {
            const isActive = props.filter?.kind === 'domain' && props.filter.key === slice.key

            return (
              <button
                key={slice.id}
                type="button"
                className={`browser-domain-item ${isActive ? 'is-active' : ''}`}
                onClick={() => {
                  props.onSelect(isActive ? null : { kind: 'domain', key: slice.key })
                }}
              >
                <span className="browser-domain-name">
                  <i style={{ backgroundColor: slice.color }} />
                  {slice.label}
                </span>
                <span>{formatDuration(slice.value)}</span>
                <span>{slice.percentage.toFixed(1)}%</span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function LoadingState() {
  return <div className="state-card">正在从本地服务读取图表数据…</div>
}

function ErrorState(props: { error: string }) {
  return <div className="state-card error-card">{props.error}</div>
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
      description: '按时间查看应用段、状态段，以及浏览器应用内部的域名明细。',
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
    description: '查看应用、域名和状态分布，以及当天的聚合结果。',
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

function formatDateHeading(date: string) {
  const parsed = parseDateString(date)
  return `${parsed.getUTCFullYear()} / ${String(parsed.getUTCMonth() + 1).padStart(2, '0')} / ${String(parsed.getUTCDate()).padStart(2, '0')}`
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
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
