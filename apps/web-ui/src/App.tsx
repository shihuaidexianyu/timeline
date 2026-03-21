/* Main dashboard for inspecting the local focus timeline and summary statistics. */

import { startTransition, useEffect, useState } from 'react'
import './App.css'
import {
  type BrowserSegment,
  type DurationStat,
  type FocusSegment,
  type FocusStats,
  type PresenceSegment,
  getAppStats,
  getDomainStats,
  getFocusStats,
  getTimeline,
} from './api'

type DashboardState = {
  timeline: {
    date: string
    timezone: string
    focus_segments: FocusSegment[]
    browser_segments: BrowserSegment[]
    presence_segments: PresenceSegment[]
  }
  appStats: DurationStat[]
  domainStats: DurationStat[]
  focusStats: FocusStats
}

const HOURS_IN_DAY = 24
const DAY_SECONDS = HOURS_IN_DAY * 60 * 60

function App() {
  const [selectedDate, setSelectedDate] = useState(() => todayString())
  const [dashboard, setDashboard] = useState<DashboardState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const [timeline, appStats, domainStats, focusStats] = await Promise.all([
          getTimeline(selectedDate),
          getAppStats(selectedDate),
          getDomainStats(selectedDate),
          getFocusStats(selectedDate),
        ])

        if (cancelled) {
          return
        }

        setDashboard({
          timeline,
          appStats,
          domainStats,
          focusStats,
        })
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
  }, [selectedDate])

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Windows 本地个人注意力时间线系统</p>
          <h1>把一天的注意力切换，画成可以复盘的时间线。</h1>
          <p className="hero-text">
            当前页面直接连接本机 `desktop-agent`，展示应用时间线、域名时间线和
            `active / idle / locked` 状态。
          </p>
        </div>
        <label className="date-card">
          <span>选择日期</span>
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
          <small>按本地时区读取每日数据</small>
        </label>
      </section>

      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} /> : null}

      {!loading && !error && dashboard ? (
        <>
          <section className="summary-grid">
            <SummaryCard
              title="专注总时长"
              value={formatDuration(dashboard.focusStats.total_focus_seconds)}
              caption="当天 focus timeline 累计"
            />
            <SummaryCard
              title="真实使用时间"
              value={formatDuration(dashboard.focusStats.total_active_seconds)}
              caption="presence = active"
            />
            <SummaryCard
              title="最长连续专注"
              value={formatDuration(dashboard.focusStats.longest_focus_block_seconds)}
              caption="单个 focus segment 的最长时长"
            />
            <SummaryCard
              title="切换次数"
              value={`${dashboard.focusStats.switch_count}`}
              caption="当天应用切换总次数"
            />
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">每日时间线</p>
                <h2>应用、域名与状态叠加查看</h2>
              </div>
              <p className="timezone-label">时区偏移 {dashboard.timeline.timezone}</p>
            </div>

            <div className="timeline-block">
              <TimelineHeader />
              <TimelineRow
                title="应用"
                tone="focus"
                items={dashboard.timeline.focus_segments.map((segment) => ({
                  id: `focus-${segment.id}`,
                  label: segment.app.display_name,
                  sublabel: segment.app.window_title ?? segment.app.process_name,
                  start: segment.started_at,
                  end: segment.ended_at,
                }))}
              />
              <TimelineRow
                title="域名"
                tone="browser"
                items={dashboard.timeline.browser_segments.map((segment) => ({
                  id: `browser-${segment.id}`,
                  label: segment.domain,
                  sublabel: segment.page_title ?? `标签页 ${segment.tab_id}`,
                  start: segment.started_at,
                  end: segment.ended_at,
                }))}
              />
              <TimelineRow
                title="状态"
                tone="presence"
                items={dashboard.timeline.presence_segments.map((segment) => ({
                  id: `presence-${segment.id}`,
                  label: formatPresence(segment.state),
                  sublabel: `状态段 ${segment.id}`,
                  start: segment.started_at,
                  end: segment.ended_at,
                  state: segment.state,
                }))}
              />
            </div>
          </section>

          <section className="dual-panel">
            <div className="panel">
              <div className="panel-header">
                <div>
                  <p className="section-kicker">时间分布</p>
                  <h2>Top 应用</h2>
                </div>
              </div>
              <StatsTable rows={dashboard.appStats} emptyLabel="当天还没有应用时间线数据" />
            </div>

            <div className="panel">
              <div className="panel-header">
                <div>
                  <p className="section-kicker">浏览器分布</p>
                  <h2>Top 域名</h2>
                </div>
              </div>
              <StatsTable rows={dashboard.domainStats} emptyLabel="当天还没有域名时间线数据" />
            </div>
          </section>

          <section className="panel focus-panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">基础分析</p>
                <h2>专注概览</h2>
              </div>
            </div>
            <div className="focus-metrics">
              <MetricChip
                label="平均专注块"
                value={formatDuration(dashboard.focusStats.average_focus_block_seconds)}
              />
              <MetricChip
                label="最长专注块"
                value={formatDuration(dashboard.focusStats.longest_focus_block_seconds)}
              />
              <MetricChip
                label="活跃时间"
                value={formatDuration(dashboard.focusStats.total_active_seconds)}
              />
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}

function SummaryCard(props: { title: string; value: string; caption: string }) {
  return (
    <article className="summary-card">
      <p>{props.title}</p>
      <strong>{props.value}</strong>
      <span>{props.caption}</span>
    </article>
  )
}

function TimelineHeader() {
  return (
    <div className="timeline-header">
      <span className="timeline-label" />
      <div className="timeline-scale">
        {Array.from({ length: HOURS_IN_DAY }).map((_, index) => (
          <span key={index}>{`${index}:00`}</span>
        ))}
      </div>
    </div>
  )
}

function TimelineRow(props: {
  title: string
  tone: 'focus' | 'browser' | 'presence'
  items: Array<{
    id: string
    label: string
    sublabel: string
    start: string
    end: string | null
    state?: 'active' | 'idle' | 'locked'
  }>
}) {
  return (
    <div className="timeline-row">
      <span className="timeline-label">{props.title}</span>
      <div className="timeline-lane">
        {props.items.length === 0 ? (
          <p className="empty-inline">没有数据</p>
        ) : (
          props.items.map((item) => {
            const start = secondsSinceMidnight(item.start)
            const end = secondsSinceMidnight(item.end ?? item.start)
            const left = (start / DAY_SECONDS) * 100
            const width = Math.max(((end - start) / DAY_SECONDS) * 100, 0.8)
            const className =
              props.tone === 'presence' && item.state
                ? `timeline-pill ${props.tone} ${item.state}`
                : `timeline-pill ${props.tone}`

            return (
              <article
                key={item.id}
                className={className}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${item.label}\n${item.sublabel}\n${formatTimeRange(
                  item.start,
                  item.end,
                )}`}
              >
                <strong>{item.label}</strong>
                <span>{item.sublabel}</span>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}

function StatsTable(props: { rows: DurationStat[]; emptyLabel: string }) {
  if (props.rows.length === 0) {
    return <div className="empty-card">{props.emptyLabel}</div>
  }

  return (
    <div className="stats-table">
      {props.rows.slice(0, 8).map((row) => (
        <div key={row.key} className="stats-row">
          <div>
            <strong>{row.label}</strong>
            <span>{row.percentage.toFixed(1)}%</span>
          </div>
          <p>{formatDuration(row.seconds)}</p>
        </div>
      ))}
    </div>
  )
}

function MetricChip(props: { label: string; value: string }) {
  return (
    <div className="metric-chip">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function LoadingState() {
  return <div className="state-card">正在从本地服务读取时间线数据…</div>
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

function formatDuration(seconds: number) {
  if (seconds <= 0) {
    return '0 分钟'
  }

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (hours === 0) {
    return `${minutes} 分钟`
  }

  if (minutes === 0) {
    return `${hours} 小时`
  }

  return `${hours} 小时 ${minutes} 分钟`
}

function secondsSinceMidnight(value: string) {
  const date = new Date(value)
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()
}

function formatTimeRange(start: string, end: string | null) {
  const startDate = new Date(start)
  const endDate = end ? new Date(end) : startDate
  const format = (value: Date) =>
    `${`${value.getHours()}`.padStart(2, '0')}:${`${value.getMinutes()}`.padStart(2, '0')}`
  return `${format(startDate)} - ${format(endDate)}`
}

function formatPresence(value: 'active' | 'idle' | 'locked') {
  if (value === 'active') {
    return 'Active'
  }
  if (value === 'idle') {
    return 'Idle'
  }
  return 'Locked'
}

export default App
