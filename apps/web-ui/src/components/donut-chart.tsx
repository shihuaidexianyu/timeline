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

export function DonutChart(props: {
  title: string
  totalLabel: string
  slices: DonutSlice[]
  filter: DashboardFilter
  filterKind: 'app' | 'domain'
  onSelect: (filter: DashboardFilter) => void
}) {
  const sliceByLabel = useMemo(
    () => new Map(props.slices.map((slice) => [slice.label, slice])),
    [props.slices],
  )

  const option = useMemo<echarts.EChartsOption>(() => {
    return {
      animation: false,
      tooltip: {
        trigger: 'item',
        appendToBody: true,
        backgroundColor: 'rgba(14, 19, 28, 0.96)',
        borderColor: 'rgba(92, 111, 145, 0.48)',
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
        orient: 'vertical',
        top: 'middle',
        right: 4,
        icon: 'circle',
        selectedMode: false,
        itemWidth: 10,
        itemHeight: 10,
        formatter: (label: string) => {
          const slice = sliceByLabel.get(label)
          if (!slice) {
            return label
          }

          return `{name|${label}}\n{meta|${formatDuration(slice.value)}  ${slice.percentage.toFixed(
            1,
          )}%}`
        },
        textStyle: {
          rich: {
            name: {
              color: LABEL_COLOR,
              fontSize: 12,
              fontWeight: 600,
              width: 170,
              overflow: 'truncate',
            },
            meta: {
              color: MUTED_COLOR,
              fontFamily: MONO_FAMILY,
              fontSize: 11,
              lineHeight: 16,
            },
          },
        },
      },
      series: [
        {
          name: props.title,
          type: 'pie',
          radius: ['58%', '80%'],
          center: ['32%', '50%'],
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: {
            borderColor: '#f7faff',
            borderWidth: 1.5,
          },
          emphasis: {
            scale: true,
            scaleSize: 8,
          },
          data: props.slices.map((slice) => {
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
          left: '32%',
          top: '43%',
          style: {
            text: props.totalLabel,
            fill: LABEL_COLOR,
            font: `600 20px ${MONO_FAMILY}`,
            textAlign: 'center',
          },
        },
        {
          type: 'text',
          left: '32%',
          top: '53%',
          style: {
            text: 'total',
            fill: MUTED_COLOR,
            font: `13px ${MONO_FAMILY}`,
            textAlign: 'center',
          },
        },
      ],
    }
  }, [props.filter, props.filterKind, props.slices, props.title, props.totalLabel, sliceByLabel])

  if (props.slices.length === 0) {
    return <div className="empty-card">没有可展示的数据</div>
  }

  return (
    <div className="donut-card">
      <div className="panel-header">
        <div>
          <p className="section-kicker">{props.filterKind}</p>
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
        style={{ height: 260, width: '100%' }}
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
