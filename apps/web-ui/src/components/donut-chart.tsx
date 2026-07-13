/* Donut chart rendered with ECharts so tooltip, legend, and selection share one engine. */

import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import {
  formatDuration,
  isFilterActive,
  type DashboardFilter,
  type DonutSlice,
} from '../lib/chart-model'
import { getEChartsThemeTokens, type ResolvedTheme } from '../lib/theme'
import { echarts, ReactEChartsCore } from './echarts-runtime'

const SANS_FAMILY = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif'
const PIE_CENTER_X = '50%'

export function DonutChart(props: {
  loading?: boolean
  title: string
  totalLabel: string
  slices: DonutSlice[]
  filter: DashboardFilter
  filterKind: 'app' | 'domain'
  resolvedTheme: ResolvedTheme
  onSelect: (filter: DashboardFilter) => void
}) {
  /** Show at most 5 slices in the legend; group the rest as "Others". */
  const isLoading = Boolean(props.loading)
  const displaySlices = useMemo(() => collapseSlices(props.slices, 5), [props.slices])
  const placeholderSlices = useMemo(() => createPlaceholderSlices(5), [])
  const rankingSlices = useMemo(
    () => props.slices.filter((slice) => slice.key !== 'others').slice(0, 5),
    [props.slices],
  )
  const chartSlices = isLoading ? placeholderSlices : displaySlices
  const rankingRows = isLoading ? placeholderSlices : rankingSlices

  const option = useMemo<EChartsOption>(() => {
    const theme = getEChartsThemeTokens(props.resolvedTheme)
    return {
      animation: !isLoading,
      animationDuration: 180,
      animationDurationUpdate: 180,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicOut',
      tooltip: {
        show: !isLoading,
        trigger: 'item',
        appendToBody: true,
        transitionDuration: 0.08,
        backgroundColor: theme.panel,
        borderColor: theme.border,
        borderWidth: 1,
        textStyle: {
          color: theme.text,
          fontFamily: SANS_FAMILY,
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
          radius: ['58%', '72%'],
          center: [PIE_CENTER_X, '50%'],
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: {
            borderColor: theme.panel,
            borderWidth: 1,
          },
          emphasis: {
            scale: false,
            itemStyle: {
              opacity: 1,
            },
          },
          data: chartSlices.map((slice) => {
            const isActive = isFilterActive(props.filter, props.filterKind, slice.key)
            const shouldDim =
              !isLoading &&
              props.filter?.kind === props.filterKind &&
              !isActive &&
              props.filter.key !== slice.key

            return {
              value: slice.value,
              name: slice.label,
              raw: slice,
              selected: isActive,
              selectedOffset: isActive ? 2 : 0,
              itemStyle: {
                color: slice.color,
                opacity: shouldDim ? 0.24 : 0.96,
              },
            }
          }),
        },
      ],
      graphic: [],
    }
  }, [
    chartSlices,
    isLoading,
    props.filter,
    props.filterKind,
    props.resolvedTheme,
    props.title,
  ])

  if (!isLoading && displaySlices.length === 0) {
    return <div className="empty-card">没有可展示的数据</div>
  }

  return (
    <div className="donut-card" data-loading={isLoading ? 'true' : 'false'}>
      <div className="donut-visual-shell">
        <ReactEChartsCore
          echarts={echarts}
          option={option}
          notMerge
          lazyUpdate
          opts={{ renderer: 'svg' }}
          onEvents={
            isLoading
              ? undefined
              : {
                click: (params: unknown) => {
                  const slice = getSliceDatum(params)
                  if (!slice || slice.key === 'others') {
                    return
                  }

                  const isActive = isFilterActive(props.filter, props.filterKind, slice.key)
                  props.onSelect(isActive ? null : { kind: props.filterKind, key: slice.key })
                },
              }
          }
          style={{ height: 288, width: '100%' }}
        />

        <div className="donut-center-copy donut-center-copy-main" aria-hidden={isLoading ? 'true' : undefined}>
          <div className="donut-center-line donut-center-line-primary">
            {isLoading ? (
              <span className="skeleton-block skeleton-inline donut-total-skeleton donut-total-skeleton-main" />
            ) : (
              props.totalLabel
            )}
          </div>
          <div className="donut-center-line donut-center-line-secondary">
            {isLoading ? (
              <span className="skeleton-block skeleton-inline donut-caption-skeleton donut-caption-skeleton-main" />
            ) : (
              '总计时长'
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="skeleton-overlay donut-visual-overlay" aria-hidden="true">
            <span className="skeleton-block donut-ring-skeleton" />
          </div>
        ) : null}
      </div>

      <div className="ranking-list">
        {rankingRows.map((slice) => {
          const isActive = isFilterActive(props.filter, props.filterKind, slice.key)

          return (
            <button
              key={`ranking-${slice.id}`}
              type="button"
              className="ranking-row"
              disabled={isLoading}
              aria-hidden={isLoading}
              onClick={() => props.onSelect(isActive ? null : { kind: props.filterKind, key: slice.key })}
            >
              {isLoading ? (
                <>
                  <span className="skeleton-block skeleton-inline skeleton-ranking-name" />
                  <span className="skeleton-block skeleton-inline skeleton-ranking-value" />
                  <span className="skeleton-block skeleton-inline skeleton-ranking-percent" />
                </>
              ) : (
                <>
                  <span className="ranking-name">
                    <i style={{ backgroundColor: slice.color }} />
                    {slice.label}
                  </span>
                  <span>{formatDuration(slice.value)}</span>
                  <span>{slice.percentage.toFixed(1)}%</span>
                </>
              )}
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
  resolvedTheme: ResolvedTheme
}) {
  const isLoading = Boolean(props.loading)
  const displaySlices = useMemo(
    () => props.slices.filter((slice) => slice.value > 0),
    [props.slices],
  )
  const placeholderSlices = useMemo(() => createPlaceholderSlices(3), [])
  const chartSlices = isLoading ? placeholderSlices : displaySlices
  const emphasizedSlice = useMemo(() => {
    if (chartSlices.length === 0) {
      return null
    }

    if (!isLoading && props.selectedKey) {
      const selected = chartSlices.find((slice) => slice.key === props.selectedKey)
      if (selected) {
        return selected
      }
    }

    return chartSlices[0]
  }, [chartSlices, isLoading, props.selectedKey])

  const option = useMemo<EChartsOption>(() => {
    const theme = getEChartsThemeTokens(props.resolvedTheme)
    return {
      animation: !isLoading,
      animationDuration: 180,
      animationDurationUpdate: 180,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicOut',
      tooltip: {
        show: !isLoading,
        trigger: 'item',
        appendToBody: true,
        transitionDuration: 0.08,
        backgroundColor: theme.panel,
        borderColor: theme.border,
        borderWidth: 1,
        textStyle: {
          color: theme.text,
          fontFamily: SANS_FAMILY,
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
          name: '状态分布',
          type: 'pie',
          radius: ['58%', '72%'],
          center: [PIE_CENTER_X, '50%'],
          selectedMode: false,
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: {
            borderColor: theme.panel,
            borderWidth: 1,
          },
          emphasis: {
            scale: false,
            itemStyle: {
              opacity: 1,
            },
          },
          data: chartSlices.map((slice) => {
            const isActive = props.selectedKey === slice.key
            const shouldDim =
              !isLoading && props.selectedKey !== null && props.selectedKey !== undefined && !isActive

            return {
              value: slice.value,
              name: slice.label,
              raw: slice,
              itemStyle: {
                color: slice.color,
                opacity: shouldDim ? 0.24 : 0.96,
                cursor: props.onSelectKey ? 'pointer' : 'default',
              },
            }
          }),
        },
      ],
      graphic: [],
    }
  }, [
    chartSlices,
    isLoading,
    props.onSelectKey,
    props.resolvedTheme,
    props.selectedKey,
  ])

  if (!isLoading && displaySlices.length === 0) {
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
    <div className="compact-donut-shell" data-loading={isLoading ? 'true' : 'false'}>
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        notMerge
        lazyUpdate
        opts={{ renderer: 'svg' }}
        onEvents={
          !isLoading && props.onSelectKey
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

      <div
        className={`donut-center-copy donut-center-copy-compact ${props.footerLabel ? 'has-footer' : ''}`}
        aria-hidden={isLoading ? 'true' : undefined}
      >
        <div className="donut-center-line donut-center-line-primary">
          {isLoading ? (
            <span className="skeleton-block skeleton-inline donut-total-skeleton donut-total-skeleton-compact" />
          ) : (
            props.totalLabel
          )}
        </div>

        <div
          className="donut-center-line donut-center-line-secondary"
          style={!isLoading && emphasizedSlice?.color ? { color: emphasizedSlice.color } : undefined}
        >
          {isLoading ? (
            <span className="skeleton-block skeleton-inline donut-caption-skeleton donut-caption-skeleton-compact" />
          ) : (
            props.secondaryLabel
          )}
        </div>

        {props.footerLabel ? (
          <div className="donut-center-line donut-center-line-footer">
            {isLoading ? (
              <span className="skeleton-block skeleton-inline donut-footer-skeleton" />
            ) : (
              props.footerLabel
            )}
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <div className="skeleton-overlay compact-donut-overlay" aria-hidden="true">
          <span className="skeleton-block donut-ring-skeleton donut-ring-skeleton-compact" />
        </div>
      ) : null}
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

function createPlaceholderSlices(count: number): DonutSlice[] {
  const palette = ['#dbe4f1', '#d1dbe9', '#c8d4e5', '#d7e0ed', '#ccd7e8']
  const normalizedCount = Math.max(count, 1)

  return Array.from({ length: normalizedCount }, (_, index) => ({
    id: `placeholder-${index}`,
    key: `placeholder-${index}`,
    label: '加载中',
    value: 1,
    percentage: 100 / normalizedCount,
    color: palette[index % palette.length],
  }))
}
