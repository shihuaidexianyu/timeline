import { lazy, Suspense } from 'react'
import { ChartLazyFallback } from '../components/chart-lazy-fallback'
import { RefreshBadge } from '../shared/ui'
import type {
  AppUsageTrendResponse,
  TrendPeriod,
  UsageMetric,
} from '../shared/api'
import type { DashboardModel } from '../lib/chart-model'

export type AppTrendView = 'day' | TrendPeriod

const LazyDayUsageView = lazy(() =>
  import('../components/day-usage-view').then((module) => ({
    default: module.DayUsageView,
  })),
)

const LazyAppUsageTrendChart = lazy(() =>
  import('../components/app-usage-trend-chart').then((module) => ({
    default: module.AppUsageTrendChart,
  })),
)

export function UsagePage(props: {
  dashboard: DashboardModel | null
  loading: boolean
  selectedDate: string
  appUsageMetric: UsageMetric
  setAppUsageMetric: (value: UsageMetric) => void
  appTrendView: AppTrendView
  setAppTrendView: (value: AppTrendView) => void
  appTrend: AppUsageTrendResponse | null
  appTrendError: string | null
  isTimelineRefreshing: boolean
  isAppTrendRefreshing: boolean
}) {
  const { appTrendView, setAppTrendView } = props
  const showTrendError = appTrendView !== 'day' && props.appTrendError && !props.appTrend
  const sourceLabel = props.appUsageMetric === 'visible_window' ? '可见窗口' : '前台焦点'
  const metricNote =
    props.appUsageMetric === 'visible_window'
      ? '可见窗口：统计当前桌面中实际露出且占据所在屏幕至少 25% 的窗口，可同时累计多个应用。'
      : '前台焦点：只统计当前获得焦点的窗口，同一时刻只累计一个应用。'

  return (
    <section className="page-stack usage-page">
      <div className="panel page-panel usage-trend-card">
        <div className="panel-header usage-trend-header">
          <div>
            <p className="section-kicker">{sourceLabel}口径</p>
            <h2>使用趋势</h2>
          </div>
          <div className="usage-trend-actions">
            <RefreshBadge
              active={
                appTrendView === 'day'
                  ? props.isTimelineRefreshing
                  : props.isAppTrendRefreshing
              }
            />
            <MetricSwitch
              value={props.appUsageMetric}
              onChange={props.setAppUsageMetric}
            />
            <div className="ui-segmented" aria-label="应用趋势范围">
              <button
                type="button"
                className={appTrendView === 'day' ? 'is-active' : ''}
                onClick={() => setAppTrendView('day')}
              >
                日内
              </button>
              <button
                type="button"
                className={appTrendView === 'week' ? 'is-active' : ''}
                onClick={() => setAppTrendView('week')}
              >
                周
              </button>
              <button
                type="button"
                className={appTrendView === 'month' ? 'is-active' : ''}
                onClick={() => setAppTrendView('month')}
              >
                月
              </button>
            </div>
          </div>
        </div>

        <p className="stats-metric-note">{metricNote}</p>

        {showTrendError ? (
          <div className="state-card error-card">{props.appTrendError}</div>
        ) : (
          <>
            {appTrendView === 'day' ? (
              <Suspense fallback={<ChartLazyFallback variant="day" />}>
                <LazyDayUsageView
                  dashboard={props.dashboard}
                  metric={props.appUsageMetric}
                  selectedDate={props.selectedDate}
                  loading={props.loading || props.isTimelineRefreshing}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<ChartLazyFallback variant="trend" />}>
                <LazyAppUsageTrendChart
                  trend={props.appTrend}
                  loading={props.loading || (props.isAppTrendRefreshing && !props.appTrend)}
                />
              </Suspense>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function MetricSwitch(props: {
  value: UsageMetric
  onChange: (value: UsageMetric) => void
}) {
  return (
    <div className="ui-segmented" aria-label="应用统计口径">
      <button
        type="button"
        className={props.value === 'visible_window' ? 'is-active' : ''}
        onClick={() => props.onChange('visible_window')}
      >
        可见窗口
      </button>
      <button
        type="button"
        className={props.value === 'focus' ? 'is-active' : ''}
        onClick={() => props.onChange('focus')}
      >
        前台焦点
      </button>
    </div>
  )
}
