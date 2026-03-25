import { Suspense, useState } from 'react'
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
    dashboard: DashboardModel
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
        props.dashboard.presenceSlices.map((slice) => [slice.key, slice.value]),
    )

    return (
        <section className="page-stack">
            <section className="stats-overview-grid">
                <WeeklyRhythmCard
                    periodSummary={props.periodSummary}
                    weekBars={props.weekBars}
                    refreshing={props.isPeriodRefreshing}
                    onSelectDate={props.onSelectDate}
                />
                <FocusBalanceCard
                    dashboard={props.dashboard}
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
                    <Suspense fallback={<div className="state-card">图表加载中…</div>}>
                        <DonutChart
                            title="应用分布"
                            totalLabel={formatDuration(props.dashboard.summary.focusSeconds)}
                            slices={props.dashboard.appSlices}
                            filter={props.appFilter}
                            filterKind="app"
                            onSelect={props.setAppFilter}
                        />
                    </Suspense>
                </div>

                <div className="panel page-panel stats-analysis-card">
                    <div className="panel-header">
                        <div>
                            <h2>域名分布</h2>
                        </div>
                        <RefreshBadge active={props.isTimelineRefreshing} />
                    </div>
                    <Suspense fallback={<div className="state-card">图表加载中…</div>}>
                        <DonutChart
                            title="域名分布"
                            totalLabel={formatDuration(sumSlices(props.dashboard.domainSlices))}
                            slices={props.dashboard.domainSlices}
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
                    {props.calendarDays.length > 0 ? (
                        <Suspense fallback={<div className="state-card">月历加载中…</div>}>
                            <CalendarGrid
                                month={props.calendarMonth}
                                days={props.calendarDays}
                                selectedDate={props.selectedDate}
                                todayDate={props.agentToday}
                                onSelectDate={props.onSelectDate}
                                onMonthChange={props.onCalendarMonthChange}
                            />
                        </Suspense>
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
    periodSummary: PeriodSummaryResponse | null
    weekBars: WeekBarDatum[]
    refreshing: boolean
    onSelectDate: (date: string) => void
}) {
    const weekActiveTotal = props.periodSummary?.week.active_seconds ?? 0
    const weekFocusTotal = props.periodSummary?.week.focus_seconds ?? 0
    const monthActiveTotal = props.periodSummary?.month.active_seconds ?? 0
    const monthFocusTotal = props.periodSummary?.month.focus_seconds ?? 0

    return (
        <article className="showcase-card showcase-card-dashboard">
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
                <div>
                    <strong>{formatDuration(weekActiveTotal)}</strong>
                    <small>本周活跃 · 当月 {formatDuration(monthActiveTotal)}</small>
                </div>
                <div>
                    <strong>{formatDuration(weekFocusTotal)}</strong>
                    <small>本周应用 · 当月 {formatDuration(monthFocusTotal)}</small>
                </div>
            </div>

            <WeeklyBarChart bars={props.weekBars} onSelectDate={props.onSelectDate} />
        </article>
    )
}

function FocusBalanceCard(props: {
    dashboard: DashboardModel
    activeSeconds: number
    idleSeconds: number
    lockedSeconds: number
    refreshing: boolean
}) {
    const activeRatio =
        props.dashboard.summary.focusSeconds > 0
            ? props.dashboard.summary.activeSeconds / props.dashboard.summary.focusSeconds
            : 0
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
                    <h2>状态分布</h2>
                </div>
                <RefreshBadge active={props.refreshing} />
            </div>

            <div className="focus-distribution-layout">
                <div className="showcase-donut-wrap">
                    <div className="showcase-compact-donut">
                        <Suspense fallback={<div className="state-card">图表加载中…</div>}>
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
                        </Suspense>
                    </div>
                </div>

                <div className="presence-legend">
                    <button
                        type="button"
                        className={`presence-legend-item ${selectedPresenceKey === 'active' ? 'is-selected' : ''}`}
                        onClick={() => setSelectedPresenceKey('active')}
                    >
                        <span className="presence-legend-name">
                            <i style={{ backgroundColor: '#2f6fdb' }} />
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
                            <i style={{ backgroundColor: '#43d6b0' }} />
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
                            <i style={{ backgroundColor: '#8b7dff' }} />
                            锁定
                        </span>
                        <strong>{formatDuration(props.lockedSeconds)}</strong>
                    </button>
                </div>
            </div>

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
        </article>
    )
}

function WeeklyBarChart(props: {
    bars: WeekBarDatum[]
    onSelectDate: (date: string) => void
}) {
    const maxValue = Math.max(
        ...props.bars.map((bar) => Math.max(bar.activeSeconds, bar.focusSeconds)),
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
                        const normalizedFocusSeconds = Math.max(bar.focusSeconds, bar.activeSeconds)
                        const focusExtraSeconds = Math.max(0, normalizedFocusSeconds - bar.activeSeconds)
                        const hasFocusExtra = focusExtraSeconds > 0
                        const activeBarHeight = `${Math.max(
                            (bar.activeSeconds / axisMaxValue) * 100,
                            bar.activeSeconds > 0 ? 10 : 0,
                        )}%`
                        const focusExtraBarHeight = `${Math.max(
                            (focusExtraSeconds / axisMaxValue) * 100,
                            focusExtraSeconds > 0 ? 10 : 0,
                        )}%`

                        return (
                            <button
                                key={bar.date}
                                type="button"
                                className={`weekly-bar-column ${bar.isSelected ? 'is-selected' : ''}`}
                                onClick={() => props.onSelectDate(bar.date)}
                                title={`${bar.date} 活跃 ${formatDuration(bar.activeSeconds)} · 应用 ${formatDuration(normalizedFocusSeconds)}`}
                            >
                                <div className="weekly-bar-track">
                                    <div
                                        className={`weekly-bar weekly-bar-active ${hasFocusExtra ? '' : 'is-cap'}`}
                                        style={{ height: activeBarHeight }}
                                    />
                                    <div
                                        className={`weekly-bar weekly-bar-focus-extra ${hasFocusExtra ? 'is-cap' : ''}`}
                                        style={{
                                            height: focusExtraBarHeight,
                                            bottom: `calc(${activeBarHeight} - 2px)`,
                                            opacity: focusExtraSeconds > 0 ? 1 : 0,
                                        }}
                                    />
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

function RefreshBadge(_props: { active: boolean }) {
    return null
}
