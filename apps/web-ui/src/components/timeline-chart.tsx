/* Timeline chart rendered with ECharts for built-in zoom, pan, and tooltip support. */

import { useMemo, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts'
import {
  formatClockRange,
  formatDuration,
  type ChartSegment,
} from '../lib/chart-model'

type TimelineRow = {
  id: string
  label: string
  segments: ChartSegment[]
  selectedKey?: string | null
}

type TimelineDatum = {
  value: [number, number, number]
  opacity: number
  selected: boolean
  segment: ChartSegment
}

type RenderParams = {
  coordSys: unknown
  dataIndex: number
}

type RenderApi = {
  coord: (value: [number, number]) => [number, number]
  size: (value: [number, number]) => number | number[]
  value: (dimension: number) => unknown
}

type GraphicElement = {
  type: string
  [key: string]: unknown
}

const DAY_SECONDS = 24 * 60 * 60
const PANEL_BG = '#f8fafc'
const GRID_COLOR = 'rgba(100, 116, 139, 0.18)'
const AXIS_COLOR = '#667085'
const LABEL_COLOR = '#0f1726'
const TEXT_COLOR = '#f8fafc'
const MONO_FONT = '12px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'

export function TimelineChart(props: {
  rows: TimelineRow[]
  viewStartSec: number
  viewEndSec: number
  selectedSegmentId?: string | null
  interactiveZoom?: boolean
  minViewHours?: number
  maxViewHours?: number
  onViewportChange?: (startSec: number, endSec: number) => void
  onSelectSegment?: (segment: ChartSegment) => void
}) {
  const chartRef = useRef<InstanceType<typeof ReactECharts> | null>(null)

  const data = useMemo<TimelineDatum[]>(() => {
    return props.rows.flatMap((row, rowIndex) =>
      row.segments.map((segment) => {
        const shouldDim =
          row.selectedKey !== null &&
          row.selectedKey !== undefined &&
          row.selectedKey !== segment.key

        return {
          value: [segment.startSec, segment.endSec, rowIndex],
          opacity: shouldDim ? 0.22 : 0.96,
          selected: props.selectedSegmentId === segment.id,
          segment,
        }
      }),
    )
  }, [props.rows, props.selectedSegmentId])

  const option = useMemo(() => {
    const visibleDuration = Math.max(props.viewEndSec - props.viewStartSec, 300)

    return {
      animation: false,
      grid: {
        top: 24,
        left: 88,
        right: 20,
        bottom: props.interactiveZoom ? 68 : 24,
      },
      tooltip: {
        trigger: 'item',
        appendToBody: true,
        backgroundColor: 'rgba(255, 255, 255, 0.98)',
        borderColor: '#d7dee7',
        borderWidth: 1,
        textStyle: {
          color: LABEL_COLOR,
          fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
        },
        formatter: (params: unknown) => {
          const datum = getTimelineDatum(params)
          if (!datum) {
            return ''
          }

          return buildTooltipMarkup(datum.segment)
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: DAY_SECONDS,
        splitNumber: visibleDuration <= 1800 ? 8 : visibleDuration <= 4 * 3600 ? 6 : 5,
        axisLabel: {
          color: AXIS_COLOR,
          fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
          formatter: (value: number) => formatAxisLabel(value, visibleDuration),
        },
        axisLine: {
          lineStyle: { color: GRID_COLOR },
        },
        axisTick: {
          show: false,
        },
        splitLine: {
          lineStyle: { color: GRID_COLOR },
        },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: props.rows.map((row) => row.label),
        axisTick: {
          show: false,
        },
        axisLine: {
          show: false,
        },
        axisLabel: {
          color: LABEL_COLOR,
          fontSize: 12,
          fontWeight: 600,
        },
        splitLine: {
          show: false,
        },
      },
      dataZoom: props.interactiveZoom
        ? [
            {
              type: 'inside',
              xAxisIndex: 0,
              filterMode: 'weakFilter',
              minSpan: (props.minViewHours ?? 1 / 12) * 3600,
              maxSpan: (props.maxViewHours ?? 24) * 3600,
              startValue: props.viewStartSec,
              endValue: props.viewEndSec,
            },
            {
              type: 'slider',
              xAxisIndex: 0,
              filterMode: 'weakFilter',
              minSpan: (props.minViewHours ?? 1 / 12) * 3600,
              maxSpan: (props.maxViewHours ?? 24) * 3600,
              height: 26,
              bottom: 12,
              brushSelect: false,
              borderColor: '#d7dee7',
              fillerColor: 'rgba(79, 124, 255, 0.14)',
              backgroundColor: PANEL_BG,
              dataBackground: {
                lineStyle: { color: 'rgba(79, 124, 255, 0.35)' },
                areaStyle: { color: 'rgba(79, 124, 255, 0.08)' },
              },
              handleStyle: {
                color: '#0f1726',
                borderColor: '#0f1726',
              },
              textStyle: {
                color: AXIS_COLOR,
                fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
              },
              startValue: props.viewStartSec,
              endValue: props.viewEndSec,
            },
          ]
        : [],
      series: [
        {
          type: 'custom',
          coordinateSystem: 'cartesian2d',
          renderItem(params: RenderParams, api: RenderApi) {
            const start = api.coord([api.value(0) as number, api.value(2) as number])
            const end = api.coord([api.value(1) as number, api.value(2) as number])
            const rawSize = api.size([0, 1])
            const bandSize = Array.isArray(rawSize) ? rawSize[1] ?? 0 : rawSize
            const bandHeight = bandSize * 0.58
            const coordSys = params.coordSys as unknown as {
              x: number
              y: number
              width: number
              height: number
            }
            const rect = echarts.graphic.clipRectByRect(
              {
                x: start[0],
                y: start[1] - bandHeight / 2,
                width: end[0] - start[0],
                height: bandHeight,
              },
              {
                x: coordSys.x,
                y: coordSys.y,
                width: coordSys.width,
                height: coordSys.height,
              },
            )

            if (!rect) {
              return null
            }

            const datum = data[params.dataIndex]
            const children: GraphicElement[] = [
              {
                type: 'rect',
                shape: rect,
                style: {
                  fill: datum.segment.color,
                  opacity: datum.opacity,
                  stroke: datum.selected ? '#0f1726' : '#ffffff',
                  lineWidth: datum.selected ? 2 : 1,
                  shadowBlur: datum.selected ? 12 : 0,
                  shadowColor: 'rgba(15, 23, 38, 0.18)',
                },
              },
            ]

            if (rect.width > 88) {
              children.push({
                type: 'text',
                style: {
                  x: rect.x + 8,
                  y: rect.y + rect.height / 2,
                  text: datum.segment.label,
                  fill: TEXT_COLOR,
                  font: MONO_FONT,
                  align: 'left',
                  verticalAlign: 'middle',
                  width: rect.width - 16,
                  overflow: 'truncate',
                  opacity: datum.opacity,
                },
              })
            }

            return {
              type: 'group',
              children,
            } as unknown
          },
          data,
        },
      ],
    } as unknown as echarts.EChartsOption
  }, [
    data,
    props.interactiveZoom,
    props.maxViewHours,
    props.minViewHours,
    props.rows,
    props.viewEndSec,
    props.viewStartSec,
  ])

  const onEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const datum = getTimelineDatum(params)
        if (!datum) {
          return
        }

        props.onSelectSegment?.(datum.segment)
      },
      datazoom: () => {
        if (!props.onViewportChange) {
          return
        }

        const instance = chartRef.current?.getEchartsInstance()
        const option = instance?.getOption()
        const zoomEntries = option?.dataZoom as Array<{
          startValue?: unknown
          endValue?: unknown
        }> | undefined

        if (!zoomEntries || zoomEntries.length === 0) {
          return
        }

        const sliderZoom = zoomEntries[zoomEntries.length - 1]
        const startValue = normalizeZoomValue(sliderZoom.startValue)
        const endValue = normalizeZoomValue(sliderZoom.endValue)

        if (startValue === null || endValue === null || endValue <= startValue) {
          return
        }

        props.onViewportChange(startValue, endValue)
      },
    }),
    [props],
  )

  if (data.length === 0) {
    return <div className="empty-card">没有可展示的时间线数据</div>
  }

  return (
    <div className="timeline-chart-host">
      <ReactECharts
        ref={chartRef}
        option={option}
        notMerge
        lazyUpdate
        onEvents={onEvents}
        opts={{ renderer: 'svg' }}
        style={{ height: props.rows.length === 1 ? 260 : 420, width: '100%' }}
      />
    </div>
  )
}

function buildTooltipMarkup(segment: ChartSegment) {
  const lines = [segment.detail, formatClockRange(segment.startSec, segment.endSec), formatDuration(segment.durationSec)]
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('')

  return [
    `<div style="min-width:180px">`,
    `<div style="font-weight:600;margin-bottom:6px">${escapeHtml(segment.label)}</div>`,
    lines,
    `</div>`,
  ].join('')
}

function formatAxisLabel(value: number, visibleDuration: number) {
  const safeValue = Math.max(0, Math.min(value, DAY_SECONDS))
  const hours = Math.floor(safeValue / 3600)
  const minutes = Math.floor((safeValue % 3600) / 60)

  if (visibleDuration <= 1800) {
    const seconds = Math.floor(safeValue % 60)
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  }

  return `${pad(hours)}:${pad(minutes)}`
}

function getTimelineDatum(params: unknown) {
  if (!params || typeof params !== 'object' || !('data' in params)) {
    return null
  }

  const data = (params as { data?: unknown }).data
  if (!data || typeof data !== 'object' || !('segment' in data)) {
    return null
  }

  return data as TimelineDatum
}

function normalizeZoomValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value)
  }

  if (Array.isArray(value) && typeof value[0] === 'number' && Number.isFinite(value[0])) {
    return Math.round(value[0])
  }

  return null
}

function pad(value: number) {
  return `${value}`.padStart(2, '0')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
