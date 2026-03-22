/* Donut chart rendered with ECharts so tooltip, legend, and selection share one engine. */

import { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts'
import {
  formatDuration,
  isFilterActive,
  type DashboardFilter,
  type DonutSlice,
} from '../lib/chart-model'

const LABEL_COLOR = '#1d2c43'
const MUTED_COLOR = '#6f839f'
const MONO_FAMILY = '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace'
const PIE_CENTER_X = '28%'
const LEGEND_WIDTH = 132

export function DonutChart(props: {
  title: string
  totalLabel: string
  slices: DonutSlice[]
  filter: DashboardFilter
  filterKind: 'app' | 'domain'
  onSelect: (filter: DashboardFilter) => void
}) {
  /** Show at most 5 slices in the legend; group the rest as "Others". */
  const displaySlices = useMemo(() => collapseSlices(props.slices, 5), [props.slices])
  const sliceByLabel = useMemo(
    () => new Map(displaySlices.map((slice) => [slice.label, slice])),
    [displaySlices],
  )

  const option = useMemo<echarts.EChartsOption>(() => {
    return {
      animation: false,
      tooltip: {
        trigger: 'item',
        appendToBody: true,
        backgroundColor: 'rgba(255, 255, 255, 0.98)',
        borderColor: 'rgba(145, 159, 180, 0.28)',
        borderWidth: 1,
        textStyle: {
          color: LABEL_COLOR,
          fontFamily: MONO_FAMILY,
        },
        formatter: (params) => {
          const slice = getSliceDatum(params)
          if (!slice) {
            return ''
          }

          return [
            `<div style="min-width:180px">`,
            `<div style="font-weight:600;margin-bottom:6px">${escapeHtml(slice.label)}</div>`,
            `<div>${escapeHtml(formatDuration(slice.value))}</div>`,
            `<div>${slice.percentage.toFixed(1)}%</div>`,
            `</div>`,
          ].join('')
        },
      },
      legend: {
        data: displaySlices.map((slice) => slice.label),
        orient: 'vertical',
        top: 'middle',
        right: 10,
        width: LEGEND_WIDTH,
        icon: 'circle',
        selectedMode: false,
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 8,
        formatter: (label: string) => {
          const slice = sliceByLabel.get(label)
          if (!slice) {
            return label
          }

          const isActive = isFilterActive(props.filter, props.filterKind, slice.key)
          const hasActiveFilter = props.filter?.kind === props.filterKind
          const isDimmed = hasActiveFilter && !isActive
          const nameStyle = isActive ? 'nameActive' : isDimmed ? 'nameDim' : 'name'
          const metaStyle = isActive ? 'metaActive' : isDimmed ? 'metaDim' : 'meta'

          return `{${nameStyle}|${truncateLabel(label, 18)}}\n{${metaStyle}|${formatDuration(
            slice.value,
          )}  ${slice.percentage.toFixed(1)}%}`
        },
        textStyle: {
          rich: {
            name: {
              color: LABEL_COLOR,
              fontSize: 11,
              fontWeight: 600,
              width: LEGEND_WIDTH,
              overflow: 'truncate',
              lineHeight: 16,
              padding: [2, 6, 2, 6],
              borderRadius: 6,
              backgroundColor: 'rgba(79, 124, 255, 0)',
            },
            nameActive: {
              color: '#13315c',
              fontSize: 11,
              fontWeight: 700,
              width: LEGEND_WIDTH,
              overflow: 'truncate',
              lineHeight: 16,
              padding: [2, 6, 2, 6],
              borderRadius: 6,
              backgroundColor: 'rgba(79, 124, 255, 0.14)',
            },
            nameDim: {
              color: '#8fa0b8',
              fontSize: 11,
              fontWeight: 500,
              width: LEGEND_WIDTH,
              overflow: 'truncate',
              lineHeight: 16,
              padding: [2, 6, 2, 6],
              borderRadius: 6,
              backgroundColor: 'rgba(79, 124, 255, 0)',
            },
            meta: {
              color: MUTED_COLOR,
              fontFamily: MONO_FAMILY,
              fontSize: 10,
              lineHeight: 14,
              padding: [1, 6, 1, 6],
              borderRadius: 6,
              backgroundColor: 'rgba(79, 124, 255, 0)',
            },
            metaActive: {
              color: '#31598f',
              fontFamily: MONO_FAMILY,
              fontSize: 10,
              fontWeight: 600,
              lineHeight: 14,
              padding: [1, 6, 1, 6],
              borderRadius: 6,
              backgroundColor: 'rgba(79, 124, 255, 0.1)',
            },
            metaDim: {
              color: '#9aabc1',
              fontFamily: MONO_FAMILY,
              fontSize: 10,
              lineHeight: 14,
              padding: [1, 6, 1, 6],
              borderRadius: 6,
              backgroundColor: 'rgba(79, 124, 255, 0)',
            },
          },
        },
      },
      series: [
        {
          name: props.title,
          type: 'pie',
          radius: ['54%', '74%'],
          center: [PIE_CENTER_X, '50%'],
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: {
            borderColor: '#f7faff',
            borderWidth: 1,
          },
          emphasis: {
            scale: true,
            scaleSize: 8,
          },
          data: displaySlices.map((slice) => {
            const isActive = isFilterActive(props.filter, props.filterKind, slice.key)
            const shouldDim =
              props.filter?.kind === props.filterKind &&
              !isActive &&
              props.filter.key !== slice.key

            return {
              value: slice.value,
              name: slice.label,
              raw: slice,
              selected: isActive,
              selectedOffset: 8,
              itemStyle: {
                color: slice.color,
                opacity: shouldDim ? 0.24 : 0.96,
              },
            }
          }),
        },
      ],
      graphic: [
        {
          type: 'text',
          left: PIE_CENTER_X,
          top: '43%',
          style: {
            text: props.totalLabel,
            fill: LABEL_COLOR,
            font: `600 17px ${MONO_FAMILY}`,
            textAlign: 'center',
          },
        },
        {
          type: 'text',
          left: PIE_CENTER_X,
          top: '53%',
          style: {
            text: '合计',
            fill: MUTED_COLOR,
            font: `13px ${MONO_FAMILY}`,
            textAlign: 'center',
          },
        },
      ],
    }
  }, [
    displaySlices,
    props.filter,
    props.filterKind,
    props.title,
    props.totalLabel,
    sliceByLabel,
  ])

  if (displaySlices.length === 0) {
    return <div className="empty-card">没有可展示的数据</div>
  }

  return (
    <div className="donut-card">
      <div className="panel-header">
        <div>
          <p className="section-kicker">{props.filterKind === 'app' ? '应用' : '域名'}</p>
          <h2>{props.title}</h2>
        </div>
      </div>

      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        opts={{ renderer: 'svg' }}
        onEvents={{
          click: (params: unknown) => {
            const slice = getSliceDatum(params)
            if (!slice || slice.key === 'others') {
              return
            }

            const isActive = isFilterActive(props.filter, props.filterKind, slice.key)
            props.onSelect(isActive ? null : { kind: props.filterKind, key: slice.key })
          },
        }}
        style={{ height: 272, width: '100%', paddingInline: 8 }}
      />
    </div>
  )
}

function getSliceDatum(params: unknown) {
  if (!params || typeof params !== 'object' || !('data' in params)) {
    return null
  }

  const data = (params as { data?: { raw?: unknown } }).data
  if (!data?.raw || typeof data.raw !== 'object') {
    return null
  }

  return data.raw as DonutSlice
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function truncateLabel(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(maxLength - 1, 1))}…`
}

function collapseSlices(slices: DonutSlice[], keepTopN: number) {
  if (slices.length <= keepTopN) {
    return slices
  }

  const primary = slices.filter((slice) => slice.key !== 'others').slice(0, keepTopN)
  const remainder = slices.filter(
    (slice) => slice.key === 'others' || !primary.some((item) => item.key === slice.key),
  )

  if (remainder.length === 0) {
    return primary
  }

  const otherValue = remainder.reduce((sum, slice) => sum + slice.value, 0)
  const totalValue = primary.reduce((sum, slice) => sum + slice.value, 0) + otherValue

  return [
    ...primary,
    {
      id: 'slice-others-collapsed',
      key: 'others',
      label: '其他',
      value: otherValue,
      percentage: totalValue === 0 ? 0 : (otherValue / totalValue) * 100,
      color: '#94a3b8',
    },
  ]
}
