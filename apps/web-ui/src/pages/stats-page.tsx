import { lazy, Suspense, useState } from 'react'
import type {
    DaySummary,
    PeriodSummaryResponse,
    UsageMetric,
} from '../api'
import { CalendarGrid } from '../components/calendar-grid'
import { ChartLazyFallback } from '../components/chart-lazy-fallback'
import {
    createWeeklySkeletonBars,
    formatPercent,
    formatWeeklyAxisTick,
    niceWeeklyAxisMax,
    sumSlices,
} from '../features/stats/stats-selectors'
import { RefreshBadge } from '../shared/ui'
import {
    formatDuration,
    presenceColor,
    type DashboardFilter,
    type DashboardModel,
    type DonutSlice,
} from '../lib/chart-model'
import type { WeekBarDatum } from '../lib/dashboard-helpers'
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
    dashboard: DashboardModel | null
    loading: boolean
    appFilter: DashboardFilter
    domainFilter: DashboardFilter
    setAppFilter: (value: DashboardFilter) => void
    setDomainFilter: (value: DashboardFilter) => void
    periodSummary: PeriodSummaryResponse | null
    appUsageMetric: UsageMetric
    appStats: DonutSlice[]
    appStatsTotalSeconds: number
    calendarDays: DaySummary[]
    calendarMonth: string
    selectedDate: string
    agentToday: string | null
    calendarError: string | null
    weekBars: WeekBarDatum[]
    isTimelineRefreshing: boolean
    isPeriodRefreshing: boolean
    isAppStatsRefreshing: boolean
    isCalendarRefreshing: boolean
    appStatsError: string | null
    onCalendarMonthChange: (month: string) => void
    onSelectDate: (date: string) => void
}) {
    const presenceByKey = new Map(
        (props.dashboard?.presenceSlices ?? []).map((slice) => [slice.key, slice.value]),
    )
    const appDistributionLoading =
        props.loading || (props.isAppStatsRefreshing && props.appStats.length === 0)

    return (
        <section className="page-stack">
            <section className="stats-overview-grid">
                <WeeklyRhythmCard
                    loading={props.loading}
                    periodSummary={props.periodSummary}
                    weekBars={props.weekBars}
                    refreshing={props.isPeriodRefreshing}
                    onSelectDate={props.onSelectDate}
                />
                <FocusBalanceCard
                    dashboard={props.dashboard}
                    loading={props.loading}
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
                            <h2>{props.appUsageMetric === 'visible_window' ? '可见窗口分布' : '应用分布'}</h2>
                        </div>
                        <RefreshBadge active={props.isAppStatsRefreshing} />
                    </div>
                    {props.appStatsError && props.appStats.length === 0 ? (
                        <div className="state-card error-card">{props.appStatsError}</div>
                    ) : (
                        <Suspense fallback={<ChartLazyFallback variant="donut" />}>
                            <LazyDonutChart
                                loading={appDistributionLoading}
                                title={props.appUsageMetric === 'visible_window' ? '可见窗口分布' : '应用分布'}
                                totalLabel={formatDuration(props.appStatsTotalSeconds)}
                                slices={props.appStats}
                                filter={props.appFilter}
                                filterKind="app"
                                onSelect={props.setAppFilter}
                            />
                        </Suspense>
                    )}
                </div>

                <div className="panel page-panel stats-analysis-card">
                    <div className="panel-header">
                        <div>
                            <h2>域名分布</h2>
                        </div>
                        <RefreshBadge active={props.isTimelineRefreshing} />
                    </div>
                    <Suspense fallback={<ChartLazyFallback variant="donut" />}>
                        <LazyDonutChart
                            loading={props.loading}
                            title="域名分布"
                            totalLabel={formatDuration(sumSlices(props.dashboard?.domainSlices ?? []))}
                            slices={props.dashboard?.domainSlices ?? []}
                            filter={props.domainFilter}
                            filterKind="domain"
                            onSelect={props.setDomainFilter}
                        />
                    </Suspense>
                </div>

                <div className="panel page-panel stats-calendar-card">
                    <div className="panel-header">
                        <div>
                            <h2>使用热度</h2>
                        </div>
                        <RefreshBadge active={props.isCalendarRefreshing} />
                    </div>
                    {props.loading || props.calendarDays.length > 0 || props.isCalendarRefreshing ? (
                        <CalendarGrid
                            loading={props.loading || (props.isCalendarRefreshing && props.calendarDays.length === 0)}
                            month={props.calendarMonth}
                            days={props.calendarDays}
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
                        <Suspense fallback={<ChartLazyFallback variant="compact-donut" />}>
                            <LazyCompactDonutChart
                                loading={props.loading}
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
                    </div>
                </div>

                <div className="presence-legend">
                    {props.loading ? (
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
                {props.loading ? (
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
    const minVisualBarPercent = 1.2
    const maxValue = Math.max(
        ...props.bars.map((bar) => Math.max(bar.activeSeconds, bar.focusSeconds)),
        1,
    )
    const axisMaxValue = niceWeeklyAxisMax(maxValue)
    const axisTicks = [axisMaxValue, axisMaxValue / 2, 0]

    return (
        <div className={`weekly-chart-shell ${props.loading ? 'weekly-chart-shell-skeleton' : ''}`} aria-hidden={props.loading ? 'true' : undefined}>
            <div className="weekly-chart-main">
                {axisTicks.map((tick) => (
                    <span
                        key={tick}
                        className={`weekly-grid-line ${props.loading ? 'weekly-grid-line-skeleton' : ''}`}
                        style={{ bottom: `${axisMaxValue === 0 ? 0 : (tick / axisMaxValue) * 100}%` }}
                    />
                ))}

                <div className={`weekly-bars ${props.loading ? 'weekly-bars-skeleton' : ''}`}>
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
                                className={`weekly-bar-column ${bar.isSelected ? 'is-selected' : ''} ${props.loading ? 'weekly-bar-column-skeleton' : ''}`}
                                onClick={() => {
                                    if (!props.loading) {
                                        props.onSelectDate(bar.date)
                                    }
                                }}
                                disabled={props.loading}
                                aria-pressed={bar.isSelected}
                                aria-label={`${bar.date}，活跃 ${formatDuration(bar.activeSeconds)}，前台 ${formatDuration(normalizedFocusSeconds)}`}
                                title={`${bar.date} 活跃 ${formatDuration(bar.activeSeconds)} · 前台 ${formatDuration(normalizedFocusSeconds)}`}
                            >
                                <div className={`weekly-bar-track ${props.loading ? 'weekly-bar-track-skeleton' : ''}`}>
                                    <div
                                        className={`weekly-bar weekly-bar-focus-base is-cap ${props.loading ? 'skeleton-block' : ''}`}
                                        style={{ height: focusBarHeight }}
                                    />
                                    <div
                                        className={`weekly-bar weekly-bar-active is-cap ${props.loading ? 'skeleton-block' : ''}`}
                                        style={{
                                            height: activeBarHeight,
                                            bottom: 0,
                                        }}
                                    />
                                </div>
                                <span className="weekly-bar-day">
                                    {props.loading ? (
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

            <div className={`weekly-axis ${props.loading ? 'weekly-axis-skeleton' : ''}`}>
                {axisTicks.map((tick) => (
                    <span key={`label-${tick}`} className="weekly-axis-label">
                        {props.loading ? (
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
