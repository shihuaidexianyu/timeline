import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import type { AppUsageTrendResponse } from '../shared/api'
import { formatDuration } from '../lib/chart-model'
import { getEChartsThemeTokens, type ResolvedTheme } from '../lib/theme'
import { echarts, ReactEChartsCore } from './echarts-runtime'

const SANS_FAMILY = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif'
const LINE_COLORS = [
  '#2f6fed',
  '#14b8a6',
  '#ef6f6c',
  '#8b5cf6',
  '#f59e0b',
  '#0ea5e9',
  '#22c55e',
  '#f97316',
]

type AxisTooltipParam = {
  dataIndex?: number
  seriesName?: string
  value?: unknown
  color?: string
}

export function AppUsageTrendChart(props: {
  trend: AppUsageTrendResponse | null
  loading?: boolean
  resolvedTheme: ResolvedTheme
}) {
  const isLoading = Boolean(props.loading) && !props.trend
  const trend = props.trend

  const option = useMemo<EChartsOption>(() => {
    if (!trend) {
      return {}
    }

    const theme = getEChartsThemeTokens(props.resolvedTheme)

    return {
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: 180,
      animationDurationUpdate: 180,
      color: LINE_COLORS,
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        transitionDuration: 0.08,
        backgroundColor: theme.panel,
        borderColor: theme.border,
        borderWidth: 1,
        textStyle: {
          color: theme.text,
          fontFamily: SANS_FAMILY,
        },
        formatter: (rawParams) => formatTooltip(rawParams, trend),
      },
      legend: {
        type: 'scroll',
        top: 0,
        left: 0,
        itemWidth: 10,
        itemHeight: 10,
        icon: 'circle',
        textStyle: {
          color: theme.textSoft,
          fontFamily: SANS_FAMILY,
        },
      },
      grid: {
        top: 46,
        left: 58,
        right: 18,
        bottom: 34,
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: trend.days.map(formatDayLabel),
        axisLine: {
          lineStyle: {
            color: theme.grid,
          },
        },
        axisTick: { show: false },
        axisLabel: {
          color: theme.textSoft,
          fontFamily: SANS_FAMILY,
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        splitLine: {
          lineStyle: {
            color: theme.grid,
            type: 'dashed',
          },
        },
        axisLabel: {
          color: theme.textSoft,
          fontFamily: SANS_FAMILY,
          formatter: (value: number) => formatAxisDuration(value),
        },
      },
      series: trend.series.map((series, index) => ({
        name: series.label,
        type: 'line',
        smooth: true,
        showSymbol: trend.days.length <= 10,
        symbolSize: 6,
        data: series.active_daily_seconds ?? series.daily_seconds,
        lineStyle: {
          width: 3,
          color: LINE_COLORS[index % LINE_COLORS.length],
        },
        itemStyle: {
          color: LINE_COLORS[index % LINE_COLORS.length],
        },
        areaStyle: {
          opacity: 0.08,
        },
        emphasis: {
          focus: 'series',
        },
      })),
    }
  }, [props.resolvedTheme, trend])

  if (isLoading) {
    return (
      <div className="app-trend-chart app-trend-chart-skeleton" aria-hidden="true">
        <span className="skeleton-block app-trend-skeleton-line is-top" />
        <span className="skeleton-block app-trend-skeleton-line is-mid" />
        <span className="skeleton-block app-trend-skeleton-line is-bottom" />
      </div>
    )
  }

  if (!trend || trend.series.length === 0) {
    return <div className="empty-card app-trend-empty">所选范围没有可展示的应用趋势</div>
  }

  return (
    <div className="app-trend-chart">
      <div role="img" aria-label="应用活跃使用趋势折线图，详细数据见隐藏表格">
        <ReactEChartsCore
          echarts={echarts}
          option={option}
          notMerge
          lazyUpdate
          opts={{ renderer: 'svg' }}
          style={{ height: 336, width: '100%' }}
        />
      </div>
      <table className="visually-hidden">
        <caption>应用活跃使用趋势数据</caption>
        <thead>
          <tr>
            <th scope="col">日期</th>
            {trend.series.map((series) => <th key={series.key} scope="col">{series.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {trend.days.map((day, dayIndex) => (
            <tr key={day}>
              <th scope="row">{day}</th>
              {trend.series.map((series) => (
                <td key={series.key}>{formatDuration((series.active_daily_seconds ?? series.daily_seconds)[dayIndex] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatTooltip(rawParams: unknown, trend: AppUsageTrendResponse) {
  const params = Array.isArray(rawParams) ? rawParams : [rawParams]
  const rows = params.filter(isAxisTooltipParam)
  const dataIndex = rows[0]?.dataIndex ?? 0
  const date = trend.days[dataIndex] ?? ''
  const sortedRows = [...rows].sort((left, right) => {
    const leftValue = Number(left.value ?? 0)
    const rightValue = Number(right.value ?? 0)
    return rightValue - leftValue
  })

  return [
    `<div style="min-width:190px">`,
    `<div style="font-weight:600;margin-bottom:8px">${escapeHtml(date)}</div>`,
    ...sortedRows.map((row) => {
      const color = typeof row.color === 'string' ? row.color : '#8da0b6'
      return [
        `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin:4px 0">`,
        `<span><i style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${escapeHtml(color)};margin-right:6px"></i>${escapeHtml(row.seriesName ?? '')}</span>`,
        `<strong>${escapeHtml(formatDuration(Number(row.value ?? 0)))}</strong>`,
        `</div>`,
      ].join('')
    }),
    `</div>`,
  ].join('')
}

function isAxisTooltipParam(value: unknown): value is AxisTooltipParam {
  return Boolean(value && typeof value === 'object')
}

function formatDayLabel(value: string) {
  const [, month, day] = value.split('-')
  if (!month || !day) {
    return value
  }

  return `${Number(month)}/${Number(day)}`
}

function formatAxisDuration(seconds: number) {
  if (seconds <= 0) {
    return '0'
  }

  if (seconds >= 3600) {
    const hours = seconds / 3600
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
  }

  return `${Math.round(seconds / 60)}m`
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
