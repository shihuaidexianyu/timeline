/* Donut chart rendered with ECharts so tooltip, legend, and selection share one engine. */

import { useMemo } from 'react'
import ReactEChartsCoreImport from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { PieChart } from 'echarts/charts'
import { GraphicComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import {
  formatDuration,
  isFilterActive,
  type DashboardFilter,
  type DonutSlice,
} from '../lib/chart-model'

echarts.use([PieChart, TooltipComponent, GraphicComponent, SVGRenderer])

const ReactEChartsCore = (
  typeof ReactEChartsCoreImport === 'object' &&
    ReactEChartsCoreImport !== null &&
    'default' in ReactEChartsCoreImport
    ? (ReactEChartsCoreImport as { default: unknown }).default
    : ReactEChartsCoreImport
) as React.ComponentType<Record<string, unknown>>

const LABEL_COLOR = '#1d2c43'
const MUTED_COLOR = '#6f839f'
const MONO_FAMILY = '"JetBrains Mono", "Cascadia Mono", "Consolas", "SFMono-Regular", monospace'
const PIE_CENTER_X = '50%'

export function DonutChart(props: {
  loading?: boolean
  title: string
  totalLabel: string
  slices: DonutSlice[]
  filter: DashboardFilter
  filterKind: 'app' | 'domain'
  onSelect: (filter: DashboardFilter) => void
}) {
  /** Show at most 5 slices in the legend; group the rest as "Others". */
  const displaySlices = useMemo(() => collapseSlices(props.slices, 5), [props.slices])
  const rankingSlices = useMemo(
    () => props.slices.filter((slice) => slice.key !== 'others').slice(0, 5),
    [props.slices],
  )

  const option = useMemo<EChartsOption>(() => {
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
      series: [
        {
          name: props.title,
          type: 'pie',
          radius: ['56%', '76%'],
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
            scaleSize: 10,
            itemStyle: {
              shadowBlur: 14,
              shadowColor: 'rgba(28, 50, 86, 0.2)',
            },
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
          top: '41%',
          style: {
            text: props.totalLabel,
            fill: LABEL_COLOR,
            font: `700 20px ${MONO_FAMILY}`,
            textAlign: 'center',
          },
        },
        {
          type: 'text',
          left: PIE_CENTER_X,
          top: '52%',
          style: {
            text: '总计时长',
            fill: MUTED_COLOR,
            font: `12px ${MONO_FAMILY}`,
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
  ])

  if (props.loading) {
    return (
      <div className="donut-card donut-card-skeleton" aria-hidden="true">
        <div className="donut-visual-skeleton">
          <span className="skeleton-block donut-ring-skeleton" />
          <span className="skeleton-block skeleton-inline donut-total-skeleton" />
          <span className="skeleton-block skeleton-inline donut-caption-skeleton" />
        </div>

        <div className="ranking-list ranking-list-skeleton">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={`donut-row-${index}`} className="ranking-row ranking-row-skeleton">
              <span className="skeleton-block skeleton-inline skeleton-ranking-name" />
              <span className="skeleton-block skeleton-inline skeleton-ranking-value" />
              <span className="skeleton-block skeleton-inline skeleton-ranking-percent" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (displaySlices.length === 0) {
    return <div className="empty-card">没有可展示的数据</div>
  }

  return (
    <div className="donut-card">
      <ReactEChartsCore
        echarts={echarts}
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
        style={{ height: 288, width: '100%', paddingInline: 14 }}
      />

      <div className="ranking-list">
        {rankingSlices.map((slice) => {
          const isActive = isFilterActive(props.filter, props.filterKind, slice.key)

          return (
            <button
              key={`ranking-${slice.id}`}
              type="button"
              className="ranking-row"
              onClick={() => props.onSelect(isActive ? null : { kind: props.filterKind, key: slice.key })}
            >
              <span className="ranking-name">
                <i style={{ backgroundColor: slice.color }} />
                {slice.label}
              </span>
              <span>{formatDuration(slice.value)}</span>
              <span>{slice.percentage.toFixed(1)}%</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function CompactDonutChart(props: {
  loading?: boolean
  slices: DonutSlice[]
  totalLabel: string
  secondaryLabel: string
  footerLabel?: string
  selectedKey?: string | null
  onSelectKey?: (key: string) => void
  emptyLabel?: string
  height?: number
}) {
  const displaySlices = useMemo(
    () => props.slices.filter((slice) => slice.value > 0),
    [props.slices],
  )
  const emphasizedSlice = useMemo(() => {
    if (displaySlices.length === 0) {
      return null
    }

    if (props.selectedKey) {
      const selected = displaySlices.find((slice) => slice.key === props.selectedKey)
      if (selected) {
        return selected
      }
    }

    return displaySlices[0]
  }, [displaySlices, props.selectedKey])

  const option = useMemo<EChartsOption>(() => {
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
      series: [
        {
          type: 'pie',
          radius: ['58%', '78%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: {
            borderColor: '#f7faff',
            borderWidth: 1,
          },
          emphasis: {
            scale: true,
            scaleSize: 7,
            itemStyle: {
              shadowBlur: 12,
              shadowColor: 'rgba(28, 50, 86, 0.2)',
            },
          },
          data: displaySlices.map((slice) => {
            const isActive = props.selectedKey === slice.key
            const shouldDim = props.selectedKey !== null && props.selectedKey !== undefined && !isActive

            return {
              value: slice.value,
              name: slice.label,
              raw: slice,
              selected: isActive,
              selectedOffset: 0,
              itemStyle: {
                color: slice.color,
                opacity: shouldDim ? 0.24 : 0.96,
                cursor: props.onSelectKey ? 'pointer' : 'default',
              },
            }
          }),
        },
      ],
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: props.footerLabel ? '38%' : '41%',
          style: {
            text: props.totalLabel,
            fill: LABEL_COLOR,
            font: `700 20px ${MONO_FAMILY}`,
            textAlign: 'center',
          },
        },
        {
          type: 'text',
          left: 'center',
          top: props.footerLabel ? '49%' : '53%',
          style: {
            text: props.secondaryLabel,
            fill: emphasizedSlice?.color ?? MUTED_COLOR,
            font: `600 12px ${MONO_FAMILY}`,
            textAlign: 'center',
          },
        },
        ...(props.footerLabel
          ? [
            {
              type: 'text' as const,
              left: 'center',
              top: '61%',
              style: {
                text: props.footerLabel,
                fill: MUTED_COLOR,
                font: `11px ${MONO_FAMILY}`,
                textAlign: 'center',
              },
            },
          ]
          : []),
      ],
    }
  }, [
    displaySlices,
    props.footerLabel,
    emphasizedSlice,
    props.onSelectKey,
    props.secondaryLabel,
    props.selectedKey,
    props.totalLabel,
  ])

  if (props.loading) {
    return (
      <div
        className="compact-donut-empty compact-donut-skeleton"
        aria-hidden="true"
        style={{ height: props.height ?? 232 }}
      >
        <span className="skeleton-block donut-ring-skeleton donut-ring-skeleton-compact" />
        <span className="skeleton-block skeleton-inline donut-total-skeleton donut-total-skeleton-compact" />
        <span className="skeleton-block skeleton-inline donut-caption-skeleton donut-caption-skeleton-compact" />
        <span className="skeleton-block skeleton-inline donut-footer-skeleton" />
      </div>
    )
  }

  if (displaySlices.length === 0) {
    return (
      <div
        className="empty-card compact-donut-empty"
        style={{ minHeight: props.height ?? 220 }}
      >
        {props.emptyLabel ?? '没有可展示的数据'}
      </div>
    )
  }

  return (
    <ReactEChartsCore
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      opts={{ renderer: 'svg' }}
      onEvents={
        props.onSelectKey
          ? {
            click: (params: unknown) => {
              const slice = getSliceDatum(params)
              if (!slice) {
                return
              }

              props.onSelectKey?.(slice.key)
            },
          }
          : undefined
      }
      style={{ height: props.height ?? 220, width: '100%' }}
    />
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
