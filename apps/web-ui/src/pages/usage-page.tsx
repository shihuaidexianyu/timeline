import { lazy, Suspense, useState } from 'react'
import { ChartLazyFallback } from '../components/chart-lazy-fallback'
import { ErrorBoundary, ErrorCard, RefreshBadge } from '../shared/ui'
import { useAppUsageTrendQuery, useDomainUsageTrendQuery } from '../shared/api'
import type { TrendPeriod, UsageMetric } from '../shared/api'
import type { SharedData } from '../app/use-shared-data'

export type AppTrendView = TrendPeriod
export type TrendDimension = 'app' | 'domain'

const LazyAppUsageTrendChart = lazy(() =>
  import('../components/app-usage-trend-chart').then((module) => ({
    default: module.AppUsageTrendChart,
  })),
)

export function UsagePage(props: {
  shared: SharedData
  appUsageMetric: UsageMetric
  setAppUsageMetric: (value: UsageMetric) => void
}) {
  const [appTrendView, setAppTrendView] = useState<AppTrendView>('week')
  const [dimension, setDimension] = useState<TrendDimension>('app')
  const trendDate = props.shared.dateState.selectedDate ?? props.shared.timelineQuery.data?.date ?? null

  const appTrendQuery = useAppUsageTrendQuery(
    trendDate ?? '',
    appTrendView,
    props.appUsageMetric,
    6,
    {
      enabled: trendDate !== null && dimension === 'app',
    },
  )

  const domainTrendQuery = useDomainUsageTrendQuery(
    trendDate ?? '',
    appTrendView,
    6,
    {
      enabled: trendDate !== null && dimension === 'domain',
    },
  )

  const trend = dimension === 'app' ? (appTrendQuery.data ?? null) : (domainTrendQuery.data ?? null)
  const isFetching = dimension === 'app' ? appTrendQuery.isFetching : domainTrendQuery.isFetching
  const queryError = dimension === 'app' ? appTrendQuery.error : domainTrendQuery.error
  const appTrendError = queryError instanceof Error
    ? queryError.message
    : queryError
      ? '趋势数据加载失败'
      : null
  const showTrendError = appTrendError && !trend
  const sourceLabel = dimension === 'domain'
    ? '域名'
    : props.appUsageMetric === 'visible_window' ? '可见窗口' : '前台焦点'
  const metricNote =
    dimension === 'domain'
      ? '按浏览器前台标签页域名累计，只统计浏览器前台时的活动标签页。'
      : props.appUsageMetric === 'visible_window'
        ? '可见窗口：统计当前桌面中实际露出且占据所在屏幕至少 25% 的窗口，可同时累计多个应用。'
        : '前台焦点：只统计当前获得焦点的窗口，同一时刻只累计一个应用。'
  const loading = !props.shared.hasDashboard

  return (
    <section className="page-stack usage-page">
      <div className="panel page-panel usage-trend-card">
        <div className="panel-header usage-trend-header">
          <div>
            <p className="section-kicker">{sourceLabel}口径</p>
            <h2>使用趋势</h2>
          </div>
          <div className="usage-trend-actions">
            <RefreshBadge active={isFetching} />
            <div className="ui-segmented" aria-label="趋势维度">
              <button
                type="button"
                className={dimension === 'app' ? 'is-active' : ''}
                onClick={() => setDimension('app')}
              >
                应用
              </button>
              <button
                type="button"
                className={dimension === 'domain' ? 'is-active' : ''}
                onClick={() => setDimension('domain')}
              >
                域名
              </button>
            </div>
            {dimension === 'app' ? (
              <MetricSwitch
                value={props.appUsageMetric}
                onChange={props.setAppUsageMetric}
              />
            ) : null}
            <div className="ui-segmented" aria-label="应用趋势范围">
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
          <ErrorCard
            message={appTrendError ?? ''}
            onRetry={() => {
              if (dimension === 'app') {
                void appTrendQuery.refetch()
              } else {
                void domainTrendQuery.refetch()
              }
            }}
            retrying={isFetching}
          />
        ) : (
          <ErrorBoundary>
            <Suspense fallback={<ChartLazyFallback variant="trend" />}>
              <LazyAppUsageTrendChart
                trend={trend}
                loading={loading || (isFetching && !trend)}
              />
            </Suspense>
          </ErrorBoundary>
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
