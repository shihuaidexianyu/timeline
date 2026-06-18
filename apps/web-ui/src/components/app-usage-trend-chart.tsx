import { useMemo, type ComponentType } from 'react'
import ReactEChartsCoreImport from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import type { AppUsageTrendResponse } from '../shared/api'
import { formatDuration } from '../lib/chart-model'
import { getEChartsTooltipColors, getThemeColor } from '../lib/theme'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer])

const ReactEChartsCore = (
  typeof ReactEChartsCoreImport === 'object' &&
    ReactEChartsCoreImport !== null &&
    'default' in ReactEChartsCoreImport
    ? (ReactEChartsCoreImport as { default: unknown }).default
    : ReactEChartsCoreImport
) as ComponentType<Record<string, unknown>>

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
}) {
  const isLoading = Boolean(props.loading) && !props.trend
  const trend = props.trend

  const option = useMemo<EChartsOption>(() => {
    if (!trend) {
      return {}
    }

    const tooltipColors = getEChartsTooltipColors()
    const labelColor = getThemeColor('--text-main', '#1f2a37')
    const axisColor = getThemeColor('--text-soft', '#667085')
    const gridColor = getThemeColor('--chart-grid', 'rgba(125, 142, 165, 0.18)')

    return {
      animation: true,
      animationDuration: 180,
      animationDurationUpdate: 180,
      color: LINE_COLORS,
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        transitionDuration: 0.08,
        backgroundColor: tooltipColors.backgroundColor,
        borderColor: tooltipColors.borderColor,
        borderWidth: 1,
        textStyle: {
          color: labelColor,
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
          color: axisColor,
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
            color: gridColor,
          },
        },
        axisTick: { show: false },
        axisLabel: {
          color: axisColor,
          fontFamily: SANS_FAMILY,
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        splitLine: {
          lineStyle: {
            color: gridColor,
            type: 'dashed',
          },
        },
        axisLabel: {
          color: axisColor,
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
        data: series.daily_seconds,
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
  }, [trend])

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
    <div className="app-trend-chart" aria-label="应用使用趋势折线图">
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        notMerge
        lazyUpdate
        opts={{ renderer: 'svg' }}
        style={{ height: 336, width: '100%' }}
      />
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
