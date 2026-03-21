/* Main analysis dashboard for focus timeline and browser detail charts. */

import { startTransition, useEffect, useMemo, useState } from 'react'
import './App.css'
import { DonutChart } from './components/donut-chart'
import { TimelineChart } from './components/timeline-chart'
import { getTimeline, type TimelineDayResponse } from './api'
import {
  buildBrowserDetailModel,
  buildDashboardModel,
  formatClockRange,
  formatDuration,
  type DashboardFilter,
} from './lib/chart-model'

const ZOOM_OPTIONS = [
  { hours: 8, label: '8h' },
  { hours: 6, label: '6h' },
  { hours: 4, label: '4h' },
  { hours: 2, label: '2h' },
  { hours: 1, label: '1h' },
  { hours: 0.5, label: '30m' },
  { hours: 0.25, label: '15m' },
  { hours: 1 / 12, label: '5m' },
] as const
const MAX_ZOOM_HOURS = 8
const MIN_ZOOM_HOURS = 1 / 12

function App() {
  const [selectedDate, setSelectedDate] = useState(() => todayString())
  const [timeline, setTimeline] = useState<TimelineDayResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [selectedBrowserSegmentId, setSelectedBrowserSegmentId] = useState<string | null>(null)
  const [zoomHours, setZoomHours] = useState<number>(MAX_ZOOM_HOURS)
  const [viewStartHour, setViewStartHour] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const nextTimeline = await getTimeline(selectedDate)
        if (cancelled) {
          return
        }

        setTimeline(nextTimeline)
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

  return (
      <main className="app-shell">
        <section className="topbar-panel">
          <div className="title-block">
            <p className="eyebrow">timeline / analysis panel</p>
            <h1>注意力分析面板</h1>
            <p className="hero-text">
              主时间线以底部缩放条为主控件，最长可看 8 小时。点击浏览器应用段后，右侧展开该时间段对应的域名明细。
            </p>
          </div>

          <div className="toolbar-grid">
            <label className="field-card">
              <span>日期</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => {
                  const nextDate = event.target.value
                  startTransition(() => {
                    setSelectedDate(nextDate)
                  })
                }}
              />
            </label>

            <label className="toggle-card">
              <span>active only</span>
              <button
                type="button"
                className={`toggle-button ${activeOnly ? 'is-active' : ''}`}
                onClick={() => {
                  setActiveOnly((value) => !value)
                  setDomainFilter(null)
                  setSelectedBrowserSegmentId(null)
                }}
              >
                {activeOnly ? 'On' : 'Off'}
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
                {error ? 'Agent offline' : 'Agent online'}
              </strong>
              <small>{lastUpdatedAt ? `updated ${lastUpdatedAt}` : 'waiting'}</small>
            </div>
          </div>
        </section>

        {loading ? <LoadingState /> : null}
        {error ? <ErrorState error={error} /> : null}

        {!loading && !error && dashboard ? (
          <>
            <section className="summary-grid">
              <SummaryCard
                title="专注时长"
                value={formatDuration(dashboard.summary.focusSeconds)}
                caption={activeOnly ? 'active only' : 'all segments'}
              />
              <SummaryCard
                title="active 时长"
                value={formatDuration(dashboard.summary.activeSeconds)}
                caption="presence = active"
              />
              <SummaryCard
                title="最长专注"
                value={formatDuration(dashboard.summary.longestFocusSeconds)}
                caption="visible longest block"
              />
              <SummaryCard
                title="切换次数"
                value={`${dashboard.summary.switchCount}`}
                caption="visible focus segments"
              />
            </section>

            <section className="meta-strip">
              <MetaPill label="date" value={timeline?.date ?? '--'} />
              <MetaPill label="tz" value={timeline?.timezone ?? '--'} />
              <MetaPill label="focus" value={`${dashboard.meta.focusCount}`} />
              <MetaPill label="browser" value={`${dashboard.meta.browserCount}`} />
              <MetaPill label="presence" value={`${dashboard.meta.presenceCount}`} />
            </section>

            <section className="zoom-panel panel">
              <div className="panel-header">
                <div>
                  <p className="section-kicker">scale</p>
                  <h2>快速尺度</h2>
                </div>
                <p className="timezone-label">
                  当前窗口 {formatHourLabel(viewStartHour)} -{' '}
                  {formatHourLabel(viewStartHour + zoomHours)} / 最长 8h
                </p>
              </div>

              <div className="zoom-controls">
                <div className="zoom-buttons">
                  {ZOOM_OPTIONS.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className={`zoom-button ${zoomHours === option.hours ? 'is-active' : ''}`}
                      onClick={() => {
                        setZoomHours(clampZoomHours(option.hours))
                      }}
                    >
                      {option.label}
                    </button>
                  ))}

                  {selectedBrowserSegment ? (
                    <button
                      type="button"
                      className="zoom-button focus-button"
                      onClick={() => {
                        const nextZoom = bestFitZoom(selectedBrowserSegment.durationSec / 3600)
                        const segmentMidpoint =
                          selectedBrowserSegment.startSec +
                          selectedBrowserSegment.durationSec / 2
                        const nextStart = clampViewStart(
                          segmentMidpoint / 3600 - nextZoom / 2,
                          nextZoom,
                        )
                        setZoomHours(nextZoom)
                        setViewStartHour(nextStart)
                      }}
                    >
                      定位到选中段
                    </button>
                  ) : null}
                </div>
                <p className="zoom-hint">拖动图表底部缩放条或滚轮缩放，顶部按钮只负责快速切换尺度。</p>
              </div>
            </section>

            <section className="dashboard-grid">
              <div className="panel timeline-panel">
                <div className="panel-header">
                  <div>
                    <p className="section-kicker">timeline</p>
                    <h2>应用主时间线</h2>
                  </div>
                  <p className="timezone-label">滚轮缩放，拖动底部缩放条，点击浏览器段查看域名明细</p>
                </div>

                <TimelineChart
                  rows={[
                    {
                      id: 'focus',
                      label: '应用',
                      segments: dashboard.focusSegments,
                      selectedKey: appFilter?.key ?? null,
                    },
                    {
                      id: 'presence',
                      label: '状态',
                      segments: dashboard.presenceSegments,
                    },
                  ]}
                  viewStartSec={viewStartSec}
                  viewEndSec={viewEndSec}
                  interactiveZoom
                  minViewHours={MIN_ZOOM_HOURS}
                  maxViewHours={MAX_ZOOM_HOURS}
                  selectedSegmentId={selectedBrowserSegment?.id ?? null}
                  onViewportChange={(nextStartSec, nextEndSec) => {
                    const nextZoom = clampZoomHours(
                      normalizeZoomHours((nextEndSec - nextStartSec) / 3600),
                    )
                    const nextStartHour = normalizeZoomHours(nextStartSec / 3600)
                    setZoomHours(nextZoom)
                    setViewStartHour(clampViewStart(nextStartHour, nextZoom))
                  }}
                  onSelectSegment={(segment) => {
                    if (segment.tone !== 'focus') {
                      return
                    }

                    if (segment.isBrowser) {
                      setSelectedBrowserSegmentId((current) =>
                        current === segment.id ? null : segment.id,
                      )
                      setDomainFilter(null)
                      return
                    }

                    setSelectedBrowserSegmentId(null)
                    setDomainFilter(null)
                  }}
                />
              </div>

              <aside className="chart-stack">
                <div className="panel">
                  <DonutChart
                    title="应用分布"
                    totalLabel={formatDuration(dashboard.summary.focusSeconds)}
                    slices={dashboard.appSlices}
                    filter={appFilter}
                    filterKind="app"
                    onSelect={(nextFilter) => {
                      setAppFilter(nextFilter)
                    }}
                  />
                </div>

                <div className="panel browser-detail-panel">
                  <div className="panel-header">
                    <div>
                      <p className="section-kicker">browser detail</p>
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

                      <div className="browser-detail-grid">
                        <DonutChart
                          title="域名占比"
                          totalLabel={formatDuration(browserDetail.totalSeconds)}
                          slices={browserDetail.slices}
                          filter={domainFilter}
                          filterKind="domain"
                          onSelect={(nextFilter) => {
                            setDomainFilter(nextFilter)
                          }}
                        />

                        <div className="detail-timeline-card">
                          <TimelineChart
                            rows={[
                              {
                                id: 'domain-detail',
                                label: '域名',
                                segments: browserDetail.segments,
                                selectedKey: domainFilter?.key ?? null,
                              },
                            ]}
                            viewStartSec={selectedBrowserSegment.startSec}
                            viewEndSec={selectedBrowserSegment.endSec}
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
              </aside>
            </section>
          </>
        ) : null}
      </main>
  )
}

function SummaryCard(props: { title: string; value: string; caption: string }) {
  return (
    <article className="summary-card">
      <span>{props.title}</span>
      <strong>{props.value}</strong>
      <small>{props.caption}</small>
    </article>
  )
}

function MetaPill(props: { label: string; value: string }) {
  return (
    <article className="meta-pill">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </article>
  )
}

function LoadingState() {
  return <div className="state-card">正在从本地服务读取图表数据…</div>
}

function ErrorState(props: { error: string }) {
  return <div className="state-card error-card">{props.error}</div>
}

function todayString() {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function formatHourLabel(hours: number) {
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
  return `${`${whole}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`
}

function bestFitZoom(targetHours: number) {
  const target = clampZoomHours(Math.max(targetHours * 1.6, MIN_ZOOM_HOURS))
  const reversed = [...ZOOM_OPTIONS].reverse()
  const match = reversed.find((option) => option.hours >= target)
  return match?.hours ?? MAX_ZOOM_HOURS
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

export default App
