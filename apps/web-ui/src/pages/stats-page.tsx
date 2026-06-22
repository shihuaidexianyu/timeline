import { lazy, Suspense, useMemo, useState } from 'react'
import type {
    PeriodSummaryResponse,
    UsageMetric,
} from '../api'
import { useAppStatsQuery, useMonthCalendarQuery } from '../shared/api'
import { CalendarGrid } from '../components/calendar-grid'
import { ChartLazyFallback } from '../components/chart-lazy-fallback'
import {
    createWeeklySkeletonBars,
    formatPercent,
    formatWeeklyAxisTick,
    niceWeeklyAxisMax,
    sumSlices,
} from '../features/stats/stats-selectors'
import { ErrorBoundary, ErrorCard, RefreshBadge } from '../shared/ui'
import {
    formatDuration,
    durationStatsToDonutSlices,
    presenceColor,
    type DashboardFilter,
    type DashboardModel,
    type DonutSlice,
} from '../lib/chart-model'
import {
    buildWeekSeries,
    isValidDateKey,
    monthFromDate,
    type WeekBarDatum,
} from '../lib/dashboard-helpers'
import type { SharedData } from '../app/use-shared-data'
export type { WeekBarDatum } from '../lib/dashboard-helpers'

const LazyDonutChart = lazy(() =>
    import('../components/donut-chart').then((module) => ({
        default: module.DonutChart,
    })),
)

const LazyCompactDonutChart = lazy(() =>
    import('../components/donut-chart').then((module) => ({
        default: module.CompactDonutChart,
    })),
)

export function StatsPage(props: {
    shared: SharedData
    appUsageMetric: UsageMetric
    appFilter: DashboardFilter
    domainFilter: DashboardFilter
    setAppFilter: (value: DashboardFilter) => void
    setDomainFilter: (value: DashboardFilter) => void
    onSelectDate: (date: string) => void
    onCalendarMonthChange: (month: string) => void
}) {
    const { shared, appUsageMetric } = props
    const dashboard = shared.dashboard
    const selectedDate = shared.resolvedSelectedDate
    const periodSummary = shared.selectedPeriodSummary ?? null
    const loading = !shared.hasDashboard

    // Page-specific queries: only fetched when this page is mounted.
    const calendarMonth = shared.dateState.calendarMonth ?? monthFromDate(selectedDate)
    const calendarQuery = useMonthCalendarQuery(calendarMonth)
    const appStatsDate = shared.dateState.selectedDate ?? shared.timelineQuery.data?.date ?? null
    const appStatsQuery = useAppStatsQuery(appStatsDate ?? '', appUsageMetric, {
        enabled: appStatsDate !== null,
    })

    const appStatSlices = useMemo(
        () => durationStatsToDonutSlices(appStatsQuery.data ?? [], 'app'),
        [appStatsQuery.data],
    )
    const appStatTotalSeconds = useMemo(
        () => (appStatsQuery.data ?? []).reduce((sum, item) => sum + item.seconds, 0),
        [appStatsQuery.data],
    )
    const weekBars = useMemo(
        () =>
            isValidDateKey(selectedDate)
                ? buildWeekSeries(calendarQuery.data?.days ?? [], selectedDate)
                : [],
        [calendarQuery.data?.days, selectedDate],
    )

    const presenceByKey = new Map(
        (dashboard?.presenceSlices ?? []).map((slice) => [slice.key, slice.value]),
    )
    const appDistributionLoading =
        loading || (appStatsQuery.isFetching && appStatSlices.length === 0)
    const appStatSlicesError = appStatsQuery.error instanceof Error
        ? appStatsQuery.error.message
        : appStatsQuery.error
            ? '应用统计数据加载失败'
            : null

    // First-run guidance: when data has loaded but is completely empty (no
    // focus/presence/visible-window segments), show a welcome card instead of
    // empty charts so the user knows the agent is working.
    const isEmpty =
        !loading &&
        (dashboard?.summary.focusSeconds ?? 0) === 0 &&
        (dashboard?.summary.activeSeconds ?? 0) === 0 &&
        (calendarQuery.data?.days ?? []).every(
            (day) => day.focus_seconds === 0 && day.active_seconds === 0,
        )

    if (isEmpty) {
        return (
            <section className="page-stack">
                <div className="state-card empty-card" style={{ padding: '2.5rem', textAlign: 'center' }}>
                    <h2 style={{ marginBottom: '0.75rem' }}>Timeline 正在后台记录</h2>
                    <p style={{ color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: '32rem', margin: '0 auto' }}>
                        我们刚开始收集你的活动数据，需要几分钟才能生成统计图表。
                        请正常使用电脑，几分钟后刷新此页面即可看到今日时间线、应用分布和使用热度。
                    </p>
                </div>
            </section>
        )
    }

    return (
        <section className="page-stack">
            <section className="stats-overview-grid">
                <WeeklyRhythmCard
                    loading={loading}
                    periodSummary={periodSummary}
                    weekBars={weekBars}
                    refreshing={shared.selectedPeriodQuery.isFetching && Boolean(shared.selectedPeriodSummary)}
                    onSelectDate={props.onSelectDate}
                />
                <FocusBalanceCard
                    dashboard={dashboard}
                    loading={loading}
                    activeSeconds={presenceByKey.get('active') ?? 0}
                    idleSeconds={presenceByKey.get('idle') ?? 0}
                    lockedSeconds={presenceByKey.get('locked') ?? 0}
                    refreshing={shared.isTimelineRefreshing}
                />
            </section>

            <section className="stats-analysis-grid">
                <div className="panel page-panel stats-analysis-card">
                    <div className="panel-header">
                        <div>
                            <h2>{appUsageMetric === 'visible_window' ? '可见窗口分布' : '应用分布'}</h2>
                        </div>
                        <RefreshBadge active={appStatsQuery.isFetching} />
                    </div>
                    <p className="stats-metric-note">
                        {appUsageMetric === 'visible_window'
                            ? '按实际露出的可见窗口累计，同一时间多个窗口可并行计时，总时长可能超过活跃时长。'
                            : '按前台焦点窗口累计，同一时刻只累计一个应用。'}
                    </p>
                    {appStatSlicesError && appStatSlices.length === 0 ? (
                        <ErrorCard
                            message={appStatSlicesError}
                            onRetry={() => { void appStatsQuery.refetch() }}
                            retrying={appStatsQuery.isFetching}
                        />
                    ) : (
                        <ErrorBoundary>
                            <Suspense fallback={<ChartLazyFallback variant="donut" />}>
                                <LazyDonutChart
                                    loading={appDistributionLoading}
                                    title={appUsageMetric === 'visible_window' ? '可见窗口分布' : '应用分布'}
                                    totalLabel={formatDuration(appStatTotalSeconds)}
                                    slices={appStatSlices}
                                    filter={props.appFilter}
                                    filterKind="app"
                                    onSelect={props.setAppFilter}
                                />
                            </Suspense>
                        </ErrorBoundary>
                    )}
                </div>

                <div className="panel page-panel stats-analysis-card">
                    <div className="panel-header">
                        <div>
                            <h2>域名分布</h2>
                        </div>
                        <RefreshBadge active={shared.isTimelineRefreshing} />
                    </div>
                    <ErrorBoundary>
                        <Suspense fallback={<ChartLazyFallback variant="donut" />}>
                            <LazyDonutChart
                                loading={loading}
                                title="域名分布"
                                totalLabel={formatDuration(sumSlices(dashboard?.domainSlices ?? []))}
                                slices={dashboard?.domainSlices ?? []}
                                filter={props.domainFilter}
                                filterKind="domain"
                                onSelect={props.setDomainFilter}
                            />
                        </Suspense>
                    </ErrorBoundary>
                </div>

                <div className="panel page-panel stats-calendar-card">
                    <div className="panel-header">
                        <div>
                            <h2>使用热度</h2>
                        </div>
                        <RefreshBadge active={calendarQuery.isFetching} />
                    </div>
                    {loading || (calendarQuery.data?.days ?? []).length > 0 || calendarQuery.isFetching ? (
                        <CalendarGrid
                            loading={loading || (calendarQuery.isFetching && (calendarQuery.data?.days ?? []).length === 0)}
                            month={calendarMonth}
                            days={calendarQuery.data?.days ?? []}
                            selectedDate={selectedDate}
                            todayDate={shared.selectedPeriodSummary?.date ?? null}
                            onSelectDate={props.onSelectDate}
                            onMonthChange={props.onCalendarMonthChange}
                        />
            ) : calendarQuery.error ? (
                <ErrorCard
                    message={calendarQuery.error instanceof Error ? calendarQuery.error.message : '日历数据加载失败'}
                            onRetry={() => { void calendarQuery.refetch() }}
                            retrying={calendarQuery.isFetching}
                        />
                    ) : (
                        <div className="state-card">加载中…</div>
                    )}
                </div>
            </section>
        </section>
    )
}

function WeeklyRhythmCard(props: {
    loading: boolean
    periodSummary: PeriodSummaryResponse | null
    weekBars: WeekBarDatum[]
    refreshing: boolean
    onSelectDate: (date: string) => void
}) {
    const showLoadingSkeleton = props.loading && !props.periodSummary && props.weekBars.length === 0
    const weekActiveTotal = props.periodSummary?.week.active_seconds ?? 0
    const weekFocusTotal = props.periodSummary?.week.focus_seconds ?? 0
    const monthActiveTotal = props.periodSummary?.month.active_seconds ?? 0
    const monthFocusTotal = props.periodSummary?.month.focus_seconds ?? 0
    const bars = showLoadingSkeleton ? createWeeklySkeletonBars() : props.weekBars

    return (
        <article className="showcase-card showcase-card-dashboard" data-loading={showLoadingSkeleton ? 'true' : 'false'}>
            <div className="showcase-card-head">
                <div>
                    <h2>本周节奏</h2>
                </div>
                <div className="card-head-side">
                    <RefreshBadge active={props.refreshing} />
                    <div className="weekly-legend" aria-label="本周节奏图例">
                        <span className="weekly-legend-item is-active">活跃</span>
                        <span className="weekly-legend-item is-focus">前台</span>
                    </div>
                </div>
            </div>

            <div className="weekly-summary-row">
                <div className={showLoadingSkeleton ? 'weekly-summary-skeleton' : undefined}>
                    <strong>
                        {showLoadingSkeleton ? (
                            <span className="skeleton-block skeleton-inline skeleton-stat-value" />
                        ) : (
                            formatDuration(weekActiveTotal)
                        )}
                    </strong>
                    <small>
                        {showLoadingSkeleton ? (
                            <span className="skeleton-block skeleton-inline skeleton-stat-caption" />
                        ) : (
                            `本周活跃 · 当月 ${formatDuration(monthActiveTotal)}`
                        )}
                    </small>
                </div>

                <div className={showLoadingSkeleton ? 'weekly-summary-skeleton' : undefined}>
                    <strong>
                        {showLoadingSkeleton ? (
                            <span className="skeleton-block skeleton-inline skeleton-stat-value" />
                        ) : (
                            formatDuration(weekFocusTotal)
                        )}
                    </strong>
                    <small>
                        {showLoadingSkeleton ? (
                            <span className="skeleton-block skeleton-inline skeleton-stat-caption" />
                        ) : (
                            `本周前台 · 当月 ${formatDuration(monthFocusTotal)}`
                        )}
                    </small>
                </div>
            </div>

            <WeeklyBarChart
                bars={bars}
                onSelectDate={props.onSelectDate}
                loading={showLoadingSkeleton}
            />
        </article>
    )
}

function FocusBalanceCard(props: {
    dashboard: DashboardModel | null
    loading: boolean
    activeSeconds: number
    idleSeconds: number
    lockedSeconds: number
    refreshing: boolean
}) {
    const loading = props.loading
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
    const selectedPresenceRatio = presenceTotal > 0 ? selectedPresenceValue / presenceTotal : 0
    const selectedPresenceLongestBlockSeconds = props.dashboard?.presenceSegments
        .filter((segment) => segment.key === selectedPresenceKey)
        .reduce((max, segment) => Math.max(max, segment.durationSec), 0) ?? 0
    const presenceSlices: DonutSlice[] = [
        {
            id: 'presence-active',
            key: 'active',
            label: '活跃',
            value: props.activeSeconds,
            percentage: presenceTotal === 0 ? 0 : (props.activeSeconds / presenceTotal) * 100,
            color: presenceColor('active'),
        },
        {
            id: 'presence-idle',
            key: 'idle',
            label: '空闲',
            value: props.idleSeconds,
            percentage: presenceTotal === 0 ? 0 : (props.idleSeconds / presenceTotal) * 100,
            color: presenceColor('idle'),
        },
        {
            id: 'presence-locked',
            key: 'locked',
            label: '锁定',
            value: props.lockedSeconds,
            percentage: presenceTotal === 0 ? 0 : (props.lockedSeconds / presenceTotal) * 100,
            color: presenceColor('locked'),
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
                        <ErrorBoundary>
                            <Suspense fallback={<ChartLazyFallback variant="compact-donut" />}>
                                <LazyCompactDonutChart
                                    loading={loading}
                                    slices={presenceSlices}
                                    totalLabel={formatDuration(selectedPresenceValue)}
                                    secondaryLabel={selectedPresenceLabel}
                                    footerLabel={`总状态 ${formatDuration(presenceTotal)}`}
                                    selectedKey={selectedPresenceKey}
                                    onSelectKey={(key) => {
                                        if (key === 'active' || key === 'idle' || key === 'locked') {
                                            setSelectedPresenceKey(key)
                                        }
                                    }}
                                    height={232}
                                    emptyLabel="所选日期没有状态分布数据"
                                />
                            </Suspense>
                        </ErrorBoundary>
                    </div>
                </div>

                <div className="presence-legend">
                    {loading ? (
                        Array.from({ length: 3 }, (_, index) => (
                            <div key={`presence-skeleton-${index}`} className="presence-legend-item presence-legend-item-skeleton">
                                <span className="skeleton-block skeleton-inline skeleton-legend-title" />
                                <span className="skeleton-block skeleton-inline skeleton-legend-value" />
                            </div>
                        ))
                    ) : (
                        <>
                            <button
                                type="button"
                                className={`presence-legend-item ${selectedPresenceKey === 'active' ? 'is-selected' : ''}`}
                                onClick={() => setSelectedPresenceKey('active')}
                            >
                                <span className="presence-legend-name">
                                    <i style={{ backgroundColor: 'var(--presence-active)' }} />
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
                                    <i style={{ backgroundColor: 'var(--presence-idle)' }} />
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
                                    <i style={{ backgroundColor: 'var(--presence-locked)' }} />
                                    锁定
                                </span>
                                <strong>{formatDuration(props.lockedSeconds)}</strong>
                            </button>
                        </>
                    )}
                </div>
            </div>

            <div className="focus-metric-stack">
                {loading ? (
                    <>
                        <div className="focus-metric-card focus-metric-card-skeleton">
                            <span className="skeleton-block skeleton-inline skeleton-metric-label" />
                            <strong className="skeleton-metric-value">
                                <span className="skeleton-block skeleton-inline skeleton-metric-value-block" />
                            </strong>
                        </div>
                        <div className="focus-metric-card focus-metric-card-skeleton">
                            <span className="skeleton-block skeleton-inline skeleton-metric-label" />
                            <strong className="skeleton-metric-value">
                                <span className="skeleton-block skeleton-inline skeleton-metric-value-block" />
                            </strong>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="focus-metric-card">
                            <span>{selectedPresenceLabel}最长连续</span>
                            <strong>{formatDuration(selectedPresenceLongestBlockSeconds)}</strong>
                        </div>
                        <div className="focus-metric-card">
                            <span>{selectedPresenceLabel}占比</span>
                            <strong>{formatPercent(selectedPresenceRatio)}</strong>
                        </div>
                    </>
                )}
            </div>
        </article>
    )
}

function WeeklyBarChart(props: {
    bars: WeekBarDatum[]
    onSelectDate: (date: string) => void
    loading?: boolean
}) {
    const loading = props.loading ?? false
    const minVisualBarPercent = 1.2
    const maxValue = Math.max(
        ...props.bars.map((bar) => Math.max(bar.activeSeconds, bar.focusSeconds)),
        1,
    )
    const axisMaxValue = niceWeeklyAxisMax(maxValue)
    const axisTicks = [axisMaxValue, axisMaxValue / 2, 0]

    return (
        <div className={`weekly-chart-shell ${loading ? 'weekly-chart-shell-skeleton' : ''}`} aria-hidden={loading ? 'true' : undefined}>
            <div className="weekly-chart-main">
                {axisTicks.map((tick) => (
                    <span
                        key={tick}
                        className={`weekly-grid-line ${loading ? 'weekly-grid-line-skeleton' : ''}`}
                        style={{ bottom: `${axisMaxValue === 0 ? 0 : (tick / axisMaxValue) * 100}%` }}
                    />
                ))}

                <div className={`weekly-bars ${loading ? 'weekly-bars-skeleton' : ''}`}>
                    {props.bars.map((bar) => {
                        const normalizedFocusSeconds = Math.max(bar.focusSeconds, bar.activeSeconds)
                        const activeBarHeightPercent = bar.activeSeconds > 0
                            ? Math.max((bar.activeSeconds / axisMaxValue) * 100, minVisualBarPercent)
                            : 0
                        const focusBarHeightPercent = normalizedFocusSeconds > 0
                            ? Math.max((normalizedFocusSeconds / axisMaxValue) * 100, minVisualBarPercent)
                            : 0
                        const activeBarHeight = `${activeBarHeightPercent}%`
                        const focusBarHeight = `${focusBarHeightPercent}%`

                        return (
                            <button
                                key={bar.date}
                                type="button"
                                className={`weekly-bar-column ${bar.isSelected ? 'is-selected' : ''} ${loading ? 'weekly-bar-column-skeleton' : ''}`}
                                onClick={() => {
                                    if (!loading) {
                                        props.onSelectDate(bar.date)
                                    }
                                }}
                                disabled={loading}
                                aria-pressed={bar.isSelected}
                                aria-label={`${bar.date}，活跃 ${formatDuration(bar.activeSeconds)}，前台 ${formatDuration(normalizedFocusSeconds)}`}
                                title={`${bar.date} 活跃 ${formatDuration(bar.activeSeconds)} · 前台 ${formatDuration(normalizedFocusSeconds)}`}
                            >
                                <div className={`weekly-bar-track ${loading ? 'weekly-bar-track-skeleton' : ''}`}>
                                    <div
                                        className={`weekly-bar weekly-bar-focus-base is-cap ${loading ? 'skeleton-block' : ''}`}
                                        style={{ height: focusBarHeight }}
                                    />
                                    <div
                                        className={`weekly-bar weekly-bar-active is-cap ${loading ? 'skeleton-block' : ''}`}
                                        style={{
                                            height: activeBarHeight,
                                            bottom: 0,
                                        }}
                                    />
                                </div>
                                <span className="weekly-bar-day">
                                    {loading ? (
                                        <span className="skeleton-block skeleton-inline skeleton-weekday-label" />
                                    ) : (
                                        bar.dayLabel
                                    )}
                                </span>
                            </button>
                        )
                    })}
                </div>
            </div>

            <div className={`weekly-axis ${loading ? 'weekly-axis-skeleton' : ''}`}>
                {axisTicks.map((tick) => (
                    <span key={`label-${tick}`} className="weekly-axis-label">
                        {loading ? (
                            <span className="skeleton-block skeleton-inline skeleton-axis-label" />
                        ) : (
                            formatWeeklyAxisTick(tick)
                        )}
                    </span>
                ))}
            </div>
        </div>
    )
}
