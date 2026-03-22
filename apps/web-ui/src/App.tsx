/* ActivityWatch-inspired multi-page dashboard for stats, timeline, and settings. */

import { startTransition, useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  API_BASE_URL,
  getAgentSettings,
  getMonthCalendar,
  getPeriodSummary,
  getTimeline,
  updateAutostart,
  type AgentSettingsResponse,
  type MonthCalendarResponse,
  type PeriodSummaryResponse,
  type TimelineDayResponse,
} from './api'
import { CalendarGrid } from './components/calendar-grid'
import { DonutChart } from './components/donut-chart'
import { TimelineChart } from './components/timeline-chart'
import {
  buildBrowserDetailModel,
  buildDashboardModel,
  formatClockRange,
  formatDuration,
  todayString,
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
  const defaultTimelineWindow = defaultTimelineViewport(todayString())
  const [page, setPage] = useHashPage()
  const [selectedDate, setSelectedDate] = useState(() => todayString())
  const [timeline, setTimeline] = useState<TimelineDayResponse | null>(null)
  const [agentSettings, setAgentSettings] = useState<AgentSettingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savingAutostart, setSavingAutostart] = useState(false)
  const [activeOnly, setActiveOnly] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [selectedBrowserSegmentId, setSelectedBrowserSegmentId] = useState<string | null>(null)
  const [zoomHours, setZoomHours] = useState<number>(defaultTimelineWindow.zoomHours)
  const [viewStartHour, setViewStartHour] = useState(defaultTimelineWindow.viewStartHour)
  const [periodSummary, setPeriodSummary] = useState<PeriodSummaryResponse | null>(null)
  const [calendarMonth, setCalendarMonth] = useState(() => monthFromDate(todayString()))
  const [monthCalendar, setMonthCalendar] = useState<MonthCalendarResponse | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const [nextTimeline, nextSettings, nextPeriod] = await Promise.all([
          getTimeline(selectedDate),
          getAgentSettings(),
          getPeriodSummary(selectedDate),
        ])
        if (cancelled) {
          return
        }

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

    void load()

    return () => {
      cancelled = true
    }
  }, [selectedDate, refreshToken])

  useEffect(() => {
    let cancelled = false
    void getMonthCalendar(calendarMonth)
      .then((data) => {
        if (!cancelled) setMonthCalendar(data)
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('月历数据加载失败', err)
          setMonthCalendar(null)
        }
      })
    return () => { cancelled = true }
  }, [calendarMonth, refreshToken])

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
              {selectedDate}
            </span>
            <span>
              <strong>时区</strong>
              {timeline?.timezone ?? '--'}
            </span>
          </div>
        </header>

        <section className="topbar-panel">
          <div className="toolbar-grid">
            <label className="field-card">
              <span>日期</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => {
                  const nextDate = event.target.value
                  const nextWindow = defaultTimelineViewport(nextDate)
                  startTransition(() => {
                    setSelectedDate(nextDate)
                    setZoomHours(nextWindow.zoomHours)
                    setViewStartHour(nextWindow.viewStartHour)
                  })
                }}
              />
            </label>

            <label className="toggle-card">
              <span>仅活跃时段</span>
              <button
                type="button"
                className={`toggle-button ${activeOnly ? 'is-active' : ''}`}
                onClick={() => {
                  setActiveOnly((value) => !value)
                  setDomainFilter(null)
                  setSelectedBrowserSegmentId(null)
                }}
              >
                {activeOnly ? '开启' : '关闭'}
              </button>
            </label>

            <button
              type="button"
              className="action-button"
              onClick={() => {
                setRefreshToken((value) => value + 1)
              }}
            >
              刷新数据
            </button>

            <div className="status-card">
              <span>连接状态</span>
              <strong className={error ? 'status-error' : 'status-ok'}>
                {error ? '服务离线' : '服务在线'}
              </strong>
              <small>{lastUpdatedAt ? `${lastUpdatedAt} 更新` : '等待连接'}</small>
            </div>
          </div>
        </section>

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
                calendarMonth={calendarMonth}
                selectedDate={selectedDate}
                onCalendarMonthChange={setCalendarMonth}
                onSelectDate={(date) => {
                  const nextWindow = defaultTimelineViewport(date)
                  startTransition(() => {
                    setSelectedDate(date)
                    setZoomHours(nextWindow.zoomHours)
                    setViewStartHour(nextWindow.viewStartHour)
                  })
                }}
              />
            ) : null}

            {page === 'timeline' ? (
              <TimelinePage
                dashboard={dashboard}
                appFilter={appFilter}
                domainFilter={domainFilter}
                selectedDate={selectedDate}
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
                selectedDate={selectedDate}
                timezone={timeline?.timezone ?? '--'}
                activeOnly={activeOnly}
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
  onCalendarMonthChange: (month: string) => void
  onSelectDate: (date: string) => void
}) {
  return (
    <section className="page-stack">
      <section className="period-summary-grid">
        <PeriodCard
          label="今日"
          active={props.periodSummary?.today.active_seconds ?? 0}
          focus={props.periodSummary?.today.focus_seconds ?? 0}
        />
        <PeriodCard
          label="本周"
          active={props.periodSummary?.week.active_seconds ?? 0}
          focus={props.periodSummary?.week.focus_seconds ?? 0}
        />
        <PeriodCard
          label="本月"
          active={props.periodSummary?.month.active_seconds ?? 0}
          focus={props.periodSummary?.month.focus_seconds ?? 0}
        />
      </section>

      {props.monthCalendar ? (
        <div className="panel">
          <CalendarGrid
            month={props.calendarMonth}
            days={props.monthCalendar.days}
            selectedDate={props.selectedDate}
            onSelectDate={props.onSelectDate}
            onMonthChange={props.onCalendarMonthChange}
          />
        </div>
      ) : null}

      <section className="stats-grid">
        <div className="panel">
          <DonutChart
            title="应用分布"
            totalLabel={formatDuration(props.dashboard.summary.focusSeconds)}
            slices={props.dashboard.appSlices}
            filter={props.appFilter}
            filterKind="app"
            onSelect={props.setAppFilter}
          />
        </div>

        <div className="panel">
          <DonutChart
            title="域名分布"
            totalLabel={formatDuration(sumSlices(props.dashboard.domainSlices))}
            slices={props.dashboard.domainSlices}
            filter={props.domainFilter}
            filterKind="domain"
            onSelect={props.setDomainFilter}
          />
        </div>

        <div className="panel">
          <DonutChart
            title="状态分布"
            totalLabel={formatDuration(sumSlices(props.dashboard.presenceSlices))}
            slices={props.dashboard.presenceSlices}
            filter={null}
            filterKind="domain"
            onSelect={() => { }}
          />
        </div>
      </section>

      <section className="stats-grid stats-grid-lists">
        <div className="panel">
          <RankingList title="应用排行" slices={props.dashboard.appSlices} />
        </div>

        <div className="panel">
          <RankingList title="域名排行" slices={props.dashboard.domainSlices} />
        </div>
      </section>
    </section>
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
      <div className="panel timeline-panel">
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

      <div className="panel browser-detail-panel">
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
  activeOnly: boolean
  savingAutostart: boolean
  onToggleAutostart: (enabled: boolean) => Promise<void>
}) {
  return (
    <section className="page-stack settings-grid">
      <div className="panel settings-card">
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

      <div className="panel settings-card">
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

      <div className="panel settings-card">
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
          <div>
            <dt>仅活跃时段</dt>
            <dd>{props.activeOnly ? '已启用' : '已禁用'}</dd>
          </div>
        </dl>

        {props.settingsError ? <div className="settings-error">{props.settingsError}</div> : null}
      </div>
    </section>
  )
}

function PeriodCard(props: { label: string; active: number; focus: number }) {
  return (
    <article className="metric-card period-card">
      <span>{props.label}</span>
      <strong>{formatDuration(props.active)}</strong>
      <small className="period-card-detail">
        应用时长 {formatDuration(props.focus)}
      </small>
    </article>
  )
}

function RankingList(props: { title: string; slices: DonutSlice[] }) {
  return (
    <div className="ranking-card">
      <div className="panel-header">
        <div>
          <p className="section-kicker">排行</p>
          <h2>{props.title}</h2>
        </div>
      </div>

      <div className="ranking-list">
        {props.slices.map((slice) => (
          <div key={slice.id} className="ranking-row">
            <span className="ranking-name">
              <i style={{ backgroundColor: slice.color }} />
              {slice.label}
            </span>
            <span>{formatDuration(slice.value)}</span>
            <span>{slice.percentage.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
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

function defaultTimelineViewport(date: string) {
  const zoomHours = 0.5
  const now = new Date()

  if (date === todayString()) {
    const currentHour = now.getHours() + now.getMinutes() / 60
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

export default App
