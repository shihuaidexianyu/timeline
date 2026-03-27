import { useState } from 'react'
import type { DaySummary, PeriodSummaryResponse } from '../api'
import { CalendarGrid } from '../components/calendar-grid'
import { CompactDonutChart, DonutChart } from '../components/donut-chart'
import {
    formatDuration,
    type DashboardFilter,
    type DashboardModel,
    type DonutSlice,
} from '../lib/chart-model'

export type WeekBarDatum = {
    date: string
    dayLabel: string
    activeSeconds: number
    focusSeconds: number
    isSelected: boolean
}

export function StatsPage(props: {
    dashboard: DashboardModel | null
    loading: boolean
    appFilter: DashboardFilter
    domainFilter: DashboardFilter
    setAppFilter: (value: DashboardFilter) => void
    setDomainFilter: (value: DashboardFilter) => void
    periodSummary: PeriodSummaryResponse | null
    calendarDays: DaySummary[]
    calendarMonth: string
    selectedDate: string
    agentToday: string | null
    calendarError: string | null
    weekBars: WeekBarDatum[]
    isTimelineRefreshing: boolean
    isPeriodRefreshing: boolean
    isCalendarRefreshing: boolean
    onCalendarMonthChange: (month: string) => void
    onSelectDate: (date: string) => void
}) {
    const presenceByKey = new Map(
        (props.dashboard?.presenceSlices ?? []).map((slice) => [slice.key, slice.value]),
    )

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
                            <h2>应用分布</h2>
                        </div>
                        <RefreshBadge active={props.isTimelineRefreshing} />
                    </div>
                    <DonutChart
                        loading={props.loading}
                        title="应用分布"
                        totalLabel={formatDuration(props.dashboard?.summary.focusSeconds ?? 0)}
                        slices={props.dashboard?.appSlices ?? []}
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
                        loading={props.loading}
                        title="域名分布"
                        totalLabel={formatDuration(sumSlices(props.dashboard?.domainSlices ?? []))}
                        slices={props.dashboard?.domainSlices ?? []}
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
                        <span className="weekly-legend-item is-focus">应用</span>
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
                            `本周应用 · 当月 ${formatDuration(monthFocusTotal)}`
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
            color: '#2f6fed',
        },
        {
            id: 'presence-idle',
            key: 'idle',
            label: '空闲',
            value: props.idleSeconds,
            percentage: presenceTotal === 0 ? 0 : (props.idleSeconds / presenceTotal) * 100,
            color: '#14b8a6',
        },
        {
            id: 'presence-locked',
            key: 'locked',
            label: '锁定',
            value: props.lockedSeconds,
            percentage: presenceTotal === 0 ? 0 : (props.lockedSeconds / presenceTotal) * 100,
            color: '#8da0b6',
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
                                aria-label={`${bar.date}，活跃 ${formatDuration(bar.activeSeconds)}，应用 ${formatDuration(normalizedFocusSeconds)}`}
                                title={`${bar.date} 活跃 ${formatDuration(bar.activeSeconds)} · 应用 ${formatDuration(normalizedFocusSeconds)}`}
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

function createWeeklySkeletonBars(): WeekBarDatum[] {
    return [
        { date: 'skeleton-1', dayLabel: '一', activeSeconds: 3.6 * 3600, focusSeconds: 4.8 * 3600, isSelected: false },
        { date: 'skeleton-2', dayLabel: '二', activeSeconds: 5.4 * 3600, focusSeconds: 6.8 * 3600, isSelected: false },
        { date: 'skeleton-3', dayLabel: '三', activeSeconds: 3.2 * 3600, focusSeconds: 3.4 * 3600, isSelected: false },
        { date: 'skeleton-4', dayLabel: '四', activeSeconds: 5.2 * 3600, focusSeconds: 5.2 * 3600, isSelected: false },
        { date: 'skeleton-5', dayLabel: '五', activeSeconds: 2.0 * 3600, focusSeconds: 2.6 * 3600, isSelected: false },
        { date: 'skeleton-6', dayLabel: '六', activeSeconds: 0, focusSeconds: 0, isSelected: false },
        { date: 'skeleton-7', dayLabel: '日', activeSeconds: 0, focusSeconds: 0, isSelected: false },
    ]
}

function sumSlices(slices: DonutSlice[]) {
    return slices.reduce((sum, slice) => sum + slice.value, 0)
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

function RefreshBadge(props: { active: boolean }) {
    void props
    return null
}
