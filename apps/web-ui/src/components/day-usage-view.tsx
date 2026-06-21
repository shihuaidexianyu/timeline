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
import { formatDuration, type DashboardModel } from '../lib/chart-model'
import {
  buildDayUsageTrendModel,
  type DayUsageTrendModel,
} from '../lib/day-usage-trend-model'
import { getEChartsTooltipColors, getThemeColor } from '../lib/theme'
import type { UsageMetric } from '../shared/api'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer])

const ReactEChartsCore = (
  typeof ReactEChartsCoreImport === 'object' &&
    ReactEChartsCoreImport !== null &&
    'default' in ReactEChartsCoreImport
    ? (ReactEChartsCoreImport as { default: unknown }).default
    : ReactEChartsCoreImport
) as ComponentType<Record<string, unknown>>

const SANS_FAMILY = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif'

export function DayUsageView(props: {
  dashboard: DashboardModel | null
  metric: UsageMetric
  selectedDate: string
  loading?: boolean
}) {
  const sourceLabel = props.metric === 'visible_window' ? '可见窗口' : '前台焦点'
  const model = useMemo(
    () => {
      const appSegments = props.metric === 'visible_window'
        ? props.dashboard?.visibleWindowSegments ?? []
        : props.dashboard?.focusSegments ?? []

      return buildDayUsageTrendModel({
        appSegments,
        limit: 6,
      })
    },
    [props.dashboard?.focusSegments, props.dashboard?.visibleWindowSegments, props.metric],
  )
  const option = useMemo(() => buildDayTrendOption(model), [model])
  const totalSeconds = model.series.reduce((total, series) => total + series.totalSeconds, 0)

  if (props.loading && !props.dashboard) {
    return (
      <div className="day-trend day-trend-skeleton" aria-hidden="true">
        <span className="skeleton-block app-trend-skeleton-line is-top" />
        <span className="skeleton-block app-trend-skeleton-line is-mid" />
        <span className="skeleton-block app-trend-skeleton-line is-bottom" />
      </div>
    )
  }

  return (
    <div className="day-trend">
      <div className="day-trend-summary">
        <div>
          <span className="day-trend-kicker">日内变化</span>
          <strong>{props.selectedDate}</strong>
          <small>{sourceLabel}口径 · 10 分钟采样</small>
        </div>
        <div className="day-trend-total">
          <span>{props.metric === 'visible_window' ? '应用累计' : '前台累计'}</span>
          <strong>{formatDuration(totalSeconds)}</strong>
        </div>
      </div>

      {model.series.length === 0 ? (
        <div className="empty-card day-trend-empty">所选日期没有可展示的日内趋势</div>
      ) : (
        <div className="day-trend-chart" aria-label="应用日内趋势折线图">
          <ReactEChartsCore
            echarts={echarts}
            option={option}
            notMerge
            lazyUpdate
            opts={{ renderer: 'svg' }}
            style={{ height: 336, width: '100%' }}
          />
        </div>
      )}
    </div>
  )
}

function buildDayTrendOption(model: DayUsageTrendModel): EChartsOption {
  const tooltipColors = getEChartsTooltipColors()
  const labelColor = getThemeColor('--text-main', '#1f2a37')
  const axisColor = getThemeColor('--text-soft', '#667085')
  const gridColor = getThemeColor('--chart-grid', 'rgba(125, 142, 165, 0.18)')

  return {
    animation: true,
    animationDuration: 180,
    animationDurationUpdate: 180,
    color: model.series.map((series) => series.color),
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
      formatter: (rawParams) => formatDayTooltip(rawParams, model),
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
      data: model.labels,
      axisLine: {
        lineStyle: { color: gridColor },
      },
      axisTick: { show: false },
      axisLabel: {
        color: axisColor,
        fontFamily: SANS_FAMILY,
        interval: 11,
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
    series: model.series.map((series) => ({
      name: series.label,
      type: 'line',
      smooth: true,
      showSymbol: false,
      symbolSize: 5,
      data: series.bucketSeconds,
      lineStyle: {
        width: 2.5,
        color: series.color,
      },
      itemStyle: {
        color: series.color,
      },
      areaStyle: {
        opacity: 0.06,
      },
      emphasis: {
        focus: 'series',
      },
    })),
  }
}

type AxisTooltipParam = {
  dataIndex?: number
  seriesName?: string
  value?: unknown
  color?: string
}

function formatDayTooltip(rawParams: unknown, model: DayUsageTrendModel) {
  const params = Array.isArray(rawParams) ? rawParams : [rawParams]
  const rows = params.filter(isAxisTooltipParam)
  const dataIndex = rows[0]?.dataIndex ?? 0
  const startLabel = model.labels[dataIndex] ?? ''
  const endLabel = model.labels[dataIndex + 1] ?? '24:00'
  const sortedRows = [...rows].sort((left, right) => Number(right.value ?? 0) - Number(left.value ?? 0))

  return [
    `<div style="min-width:190px">`,
    `<div style="font-weight:600;margin-bottom:8px">${escapeHtml(startLabel)} - ${escapeHtml(endLabel)}</div>`,
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

function formatAxisDuration(seconds: number) {
  if (seconds <= 0) {
    return '0'
  }

  if (seconds >= 60) {
    return `${Math.round(seconds / 60)}m`
  }

  return `${Math.round(seconds)}s`
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
