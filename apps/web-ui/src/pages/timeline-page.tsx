import { memo, useEffect, useMemo, useState } from 'react'
import { TimelineClock } from '../components/timeline-clock'
import { TimelineChart } from '../components/timeline-chart'
import {
  formatClockRange,
  formatDuration,
  type ChartSegment,
  type DashboardFilter,
  type DashboardModel,
} from '../lib/chart-model'
import {
  buildPrimaryBrowserDomainMap,
  buildVisibleFocusItems,
  clampNumber,
  clampViewStart,
  clampZoomHours,
  formatHourLabel,
  formatPercent,
  MAX_ZOOM_HOURS,
  MIN_ZOOM_HOURS,
  normalizeZoomHours,
  overlapDuration,
  sumOverlappedDuration,
} from '../lib/dashboard-helpers'

export type TimelineSegmentKind = 'all' | 'app' | 'browser'

const EMPTY_SEGMENTS: ChartSegment[] = []
const SEGMENT_KIND_OPTIONS: Array<{ key: TimelineSegmentKind; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'app', label: '应用' },
  { key: 'browser', label: '浏览器' },
]

export function TimelinePage(props: {
  dashboard: DashboardModel | null
  loading: boolean
  appFilter: DashboardFilter
  selectedDate: string
  activeOnly: boolean
  searchQuery: string
  segmentKind: TimelineSegmentKind
  focusedSegmentId: string | null
  viewStartHour: number
  viewStartSec: number
  viewEndSec: number
  zoomHours: number
  setActiveOnly: (activeOnly: boolean) => void
  setSearchQuery: (query: string) => void
  setSegmentKind: (kind: TimelineSegmentKind) => void
  setFocusedSegmentId: (segmentId: string | null) => void
  setZoomHours: (hours: number) => void
  setViewStartHour: (hours: number) => void
}) {
  const [hoveredFocusSegmentId, setHoveredFocusSegmentId] = useState<string | null>(null)
  const focusSegments = props.dashboard?.focusSegments ?? EMPTY_SEGMENTS
  const browserSegments = props.dashboard?.browserSegments ?? EMPTY_SEGMENTS
  const presenceSegments = props.dashboard?.presenceSegments ?? EMPTY_SEGMENTS
  const focusedSegmentId = props.focusedSegmentId
  const setFocusedSegmentId = props.setFocusedSegmentId
  const normalizedSearchQuery = normalizeSearchQuery(props.searchQuery)
  const hasSearchOrKindFilter =
    normalizedSearchQuery.length > 0 || props.segmentKind !== 'all'
  const hasAnyFilter = hasSearchOrKindFilter || props.activeOnly
  const browserDomainBySegmentId = useMemo(
    () => buildPrimaryBrowserDomainMap(focusSegments, browserSegments),
    [browserSegments, focusSegments],
  )
  const filteredFocusSegments = useMemo(
    () =>
      focusSegments.filter((segment) =>
        matchesTimelineFilter(
          segment,
          browserDomainBySegmentId.get(segment.id) ?? null,
          normalizedSearchQuery,
          props.segmentKind,
        ),
      ),
    [browserDomainBySegmentId, focusSegments, normalizedSearchQuery, props.segmentKind],
  )
  const visibleFocusItems = useMemo(
    () =>
      buildVisibleFocusItems(
        filteredFocusSegments,
        props.viewStartSec,
        props.viewEndSec,
      ),
    [filteredFocusSegments, props.viewEndSec, props.viewStartSec],
  )
  const listFocusItems = useMemo(
    () => sortSegmentsByStart(hasSearchOrKindFilter ? filteredFocusSegments : visibleFocusItems),
    [filteredFocusSegments, hasSearchOrKindFilter, visibleFocusItems],
  )
  const timelineRows = useMemo(
    () => [
      {
        id: 'focus',
        label: '应用',
        segments: filteredFocusSegments,
        selectedKey: props.appFilter?.key ?? null,
        splitByKey: false,
      },
      {
        id: 'presence',
        label: '状态',
        segments: presenceSegments,
        includeInTable: false,
      },
    ],
    [filteredFocusSegments, presenceSegments, props.appFilter],
  )

  useEffect(() => {
    if (
      focusedSegmentId !== null &&
      !filteredFocusSegments.some((segment) => segment.id === focusedSegmentId)
    ) {
      setFocusedSegmentId(null)
    }
  }, [filteredFocusSegments, focusedSegmentId, setFocusedSegmentId])
  const windowDurationSec = props.viewEndSec - props.viewStartSec
  const visibleAppCount = useMemo(
    () => new Set(visibleFocusItems.map((item) => item.key)).size,
    [visibleFocusItems],
  )
  const focusDurationSec = useMemo(
    () =>
      sumOverlappedDuration(
        filteredFocusSegments,
        props.viewStartSec,
        props.viewEndSec,
      ),
    [filteredFocusSegments, props.viewEndSec, props.viewStartSec],
  )
  const activeDurationSec = useMemo(
    () =>
      sumOverlappedDuration(
        presenceSegments.filter((segment) => segment.key === 'active'),
        props.viewStartSec,
        props.viewEndSec,
      ),
    [presenceSegments, props.viewEndSec, props.viewStartSec],
  )
  const longestVisibleDurationSec = useMemo(
    () =>
      visibleFocusItems.reduce(
        (maxDuration, segment) =>
          Math.max(maxDuration, overlapDuration(segment, props.viewStartSec, props.viewEndSec)),
        0,
      ),
    [props.viewEndSec, props.viewStartSec, visibleFocusItems],
  )
  const focusCoverageRatio =
    windowDurationSec > 0 ? clampNumber(focusDurationSec / windowDurationSec, 0, 1) : 0
  const activeRatio =
    windowDurationSec > 0 ? clampNumber(activeDurationSec / windowDurationSec, 0, 1) : 0
  const windowLabel = `${formatHourLabel(props.viewStartHour)} - ${formatHourLabel(
    props.viewStartHour + props.zoomHours,
  )}`

  function clearTimelineFilters() {
    props.setSearchQuery('')
    props.setSegmentKind('all')
    props.setActiveOnly(false)
    props.setFocusedSegmentId(null)
  }

  function focusSegment(segment: ChartSegment) {
    props.setFocusedSegmentId(segment.id)

    if (!hasSearchOrKindFilter) {
      return
    }

    const segmentCenterHour = ((segment.startSec + segment.endSec) / 2) / 3600
    props.setViewStartHour(clampViewStart(segmentCenterHour - props.zoomHours / 2, props.zoomHours))
  }

  return (
    <section className="page-stack">
      <div className="page-content-layout timeline-page-layout">
        <div className="page-content-main">
          <div className="panel page-panel timeline-panel">
            <div className="panel-header">
              <div>
                <h2>事件时间线</h2>
              </div>
            </div>

            <div className="timeline-control-bar">
              <label className="timeline-control-group timeline-control-group-search">
                <span className="timeline-control-label">搜索</span>
                <input
                  type="search"
                  className="timeline-control-search"
                  placeholder="应用、标题、域名"
                  value={props.searchQuery}
                  disabled={props.loading}
                  onChange={(event) => {
                    props.setSearchQuery(event.target.value)
                  }}
                />
              </label>

              <div className="timeline-control-group" role="group" aria-label="片段类型筛选">
                <span className="timeline-control-label">类型</span>
                {SEGMENT_KIND_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`timeline-control-button ${props.segmentKind === option.key ? 'is-active' : ''}`}
                    aria-pressed={props.segmentKind === option.key}
                    disabled={props.loading}
                    onClick={() => {
                      props.setSegmentKind(option.key)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="timeline-control-group">
                <button
                  type="button"
                  className={`timeline-control-button ${props.activeOnly ? 'is-active' : ''}`}
                  aria-pressed={props.activeOnly}
                  disabled={props.loading}
                  onClick={() => {
                    props.setActiveOnly(!props.activeOnly)
                  }}
                >
                  仅活跃时段
                </button>
              </div>

              <div className="timeline-control-group timeline-control-group-anchor">
                <span className="timeline-control-hint">
                  {hasSearchOrKindFilter
                    ? `匹配 ${listFocusItems.length}`
                    : `窗口 ${visibleFocusItems.length}`}
                </span>
                <button
                  type="button"
                  className="timeline-control-button"
                  disabled={props.loading || !hasAnyFilter}
                  onClick={clearTimelineFilters}
                >
                  清空筛选
                </button>
              </div>
            </div>

            <div className="timeline-primary-chart">
              <TimelineChart
                loading={props.loading}
                rows={timelineRows}
                viewStartSec={props.viewStartSec}
                viewEndSec={props.viewEndSec}
                baseDate={props.selectedDate}
                windowLabel={windowLabel}
                windowDurationLabel={`窗口 ${formatDuration(windowDurationSec)}`}
                windowItemCount={visibleFocusItems.length}
                highlightedSegmentId={hoveredFocusSegmentId ?? props.focusedSegmentId}
                interactiveZoom={false}
                minViewHours={MIN_ZOOM_HOURS}
                maxViewHours={MAX_ZOOM_HOURS}
                onSegmentHover={setHoveredFocusSegmentId}
                onViewportChange={(nextStartSec, nextEndSec) => {
                  const nextZoom = clampZoomHours(
                    normalizeZoomHours((nextEndSec - nextStartSec) / 3600),
                  )
                  const nextStartHour = normalizeZoomHours(nextStartSec / 3600)
                  props.setZoomHours(nextZoom)
                  props.setViewStartHour(clampViewStart(nextStartHour, nextZoom))
                }}
              />
            </div>

            <TimelineClock
              loading={props.loading}
              focusSegments={filteredFocusSegments}
              presenceSegments={presenceSegments}
              viewStartSec={props.viewStartSec}
              viewEndSec={props.viewEndSec}
              minViewSec={MIN_ZOOM_HOURS * 3600}
              maxViewSec={MAX_ZOOM_HOURS * 3600}
              onWindowChange={(nextStartSec, nextEndSec) => {
                const nextZoom = clampZoomHours(
                  normalizeZoomHours((nextEndSec - nextStartSec) / 3600),
                )
                const nextStartHour = normalizeZoomHours(nextStartSec / 3600)
                props.setZoomHours(nextZoom)
                props.setViewStartHour(clampViewStart(nextStartHour, nextZoom))
              }}
            />

            <div className="timeline-snapshot-grid" role="list" aria-label="窗口摘要">
              <article className="timeline-snapshot-card" role="listitem">
                <span>窗口时长</span>
                {props.loading ? (
                  <>
                    <strong className="timeline-snapshot-value-skeleton">
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-value" />
                    </strong>
                    <small>
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-copy" />
                    </small>
                  </>
                ) : (
                  <>
                    <strong>{formatDuration(windowDurationSec)}</strong>
                    <small>{windowLabel}</small>
                  </>
                )}
              </article>
              <article className="timeline-snapshot-card" role="listitem">
                <span>窗口覆盖</span>
                {props.loading ? (
                  <>
                    <strong className="timeline-snapshot-value-skeleton">
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-value" />
                    </strong>
                    <small>
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-copy" />
                    </small>
                  </>
                ) : (
                  <>
                    <strong>{formatPercent(focusCoverageRatio)}</strong>
                    <small>应用记录 {formatDuration(focusDurationSec)}</small>
                  </>
                )}
              </article>
              <article className="timeline-snapshot-card" role="listitem">
                <span>活跃占比</span>
                {props.loading ? (
                  <>
                    <strong className="timeline-snapshot-value-skeleton">
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-value" />
                    </strong>
                    <small>
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-copy" />
                    </small>
                  </>
                ) : (
                  <>
                    <strong>{formatPercent(activeRatio)}</strong>
                    <small>状态活跃 {formatDuration(activeDurationSec)}</small>
                  </>
                )}
              </article>
              <article className="timeline-snapshot-card" role="listitem">
                <span>应用与连续</span>
                {props.loading ? (
                  <>
                    <strong className="timeline-snapshot-value-skeleton">
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-value" />
                    </strong>
                    <small>
                      <span className="skeleton-block skeleton-inline skeleton-snapshot-copy" />
                    </small>
                  </>
                ) : (
                  <>
                    <strong>{visibleAppCount} / {formatDuration(longestVisibleDurationSec)}</strong>
                    <small>窗口内应用数 / 最长片段</small>
                  </>
                )}
              </article>
            </div>
          </div>
        </div>

        <div className="page-content-side">
          <div className="panel page-panel browser-detail-panel">
            <div className="panel-header">
              <div>
                <h2>事件列表</h2>
              </div>
              <div className="timeline-header-meta">
                {props.loading ? (
                  <span className="timeline-meta-pill timeline-meta-pill-skeleton">
                    <span className="skeleton-block skeleton-inline skeleton-meta-pill" />
                  </span>
                ) : (
                  <span className="timeline-meta-pill">
                    {hasSearchOrKindFilter
                      ? `匹配 ${listFocusItems.length}`
                      : `窗口内 ${visibleFocusItems.length}`}
                  </span>
                )}
              </div>
            </div>

            <div className="detail-list-section">
              <div className="detail-list-meta">
                <span>{hasSearchOrKindFilter ? '匹配结果' : '当前窗口'}</span>
                {props.loading ? (
                  <strong>
                    <span className="skeleton-block skeleton-inline skeleton-detail-count" />
                  </strong>
                ) : (
                  <strong>{hasSearchOrKindFilter ? listFocusItems.length : visibleFocusItems.length}</strong>
                )}
              </div>
              <div className="detail-segment-scroll">
                {props.loading ? (
                  <DetailListSkeleton />
                ) : (
                  <FocusSegmentList
                    segments={listFocusItems}
                    browserDomainBySegmentId={browserDomainBySegmentId}
                    hoveredSegmentId={hoveredFocusSegmentId}
                    focusedSegmentId={props.focusedSegmentId}
                    onHoverSegment={setHoveredFocusSegmentId}
                    onSelectSegment={focusSegment}
                    emptyLabel={hasSearchOrKindFilter ? '没有匹配片段' : '暂无记录'}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const FocusSegmentList = memo(function FocusSegmentList(props: {
  segments: ChartSegment[]
  browserDomainBySegmentId: Map<string, string>
  hoveredSegmentId: string | null
  focusedSegmentId: string | null
  onHoverSegment: (segmentId: string | null) => void
  onSelectSegment: (segment: ChartSegment) => void
  emptyLabel: string
}) {
  if (props.segments.length === 0) {
    return <div className="empty-card">{props.emptyLabel}</div>
  }

  return (
    <div className="detail-segment-list">
      {props.segments.map((segment) => {
        const segmentDomain = props.browserDomainBySegmentId.get(segment.id) ?? null
        return (
          <button
            key={segment.id}
            type="button"
            className={`detail-segment-item ${
              props.hoveredSegmentId === segment.id ? 'is-hovered' : ''
            } ${props.focusedSegmentId === segment.id ? 'is-focused' : ''}`}
            title={[
              segment.label,
              segmentDomain ?? segment.detail,
              formatClockRange(segment.startSec, segment.endSec),
            ]
              .filter((value): value is string => Boolean(value))
              .join('\n')}
            onMouseEnter={() => props.onHoverSegment(segment.id)}
            onMouseLeave={() => props.onHoverSegment(null)}
            onFocus={() => props.onHoverSegment(segment.id)}
            onBlur={() => props.onHoverSegment(null)}
            onClick={() => props.onSelectSegment(segment)}
          >
            <span className="detail-segment-row">
              <span className="detail-segment-name">
                <i style={{ backgroundColor: segment.color }} />
                {segment.label}
              </span>
              {segment.isBrowser && segmentDomain ? (
                <span className="detail-segment-domain">
                  {segmentDomain}
                </span>
              ) : null}
            </span>
            <span className="detail-segment-time">
              {formatClockRange(segment.startSec, segment.endSec)}
            </span>
          </button>
        )
      })}
    </div>
  )
})

function matchesTimelineFilter(
  segment: ChartSegment,
  domain: string | null,
  normalizedSearchQuery: string,
  segmentKind: TimelineSegmentKind,
) {
  if (segmentKind === 'app' && segment.isBrowser) {
    return false
  }

  if (segmentKind === 'browser' && !segment.isBrowser) {
    return false
  }

  if (!normalizedSearchQuery) {
    return true
  }

  return [
    segment.label,
    segment.key,
    segment.detail,
    domain,
  ].some((value) => normalizeSearchQuery(value).includes(normalizedSearchQuery))
}

function normalizeSearchQuery(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase()
}

function sortSegmentsByStart(segments: ChartSegment[]) {
  return [...segments].sort((left, right) => {
    if (left.startSec !== right.startSec) {
      return left.startSec - right.startSec
    }

    return right.durationSec - left.durationSec
  })
}

function DetailListSkeleton() {
  return (
    <div className="detail-segment-list detail-segment-list-skeleton" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={`detail-skeleton-${index}`} className="detail-segment-item detail-segment-item-skeleton">
          <span className="detail-segment-row">
            <span className="skeleton-block skeleton-inline skeleton-detail-title" />
            <span className="skeleton-block skeleton-inline skeleton-detail-domain" />
          </span>
          <span className="skeleton-block skeleton-inline skeleton-detail-time" />
        </div>
      ))}
    </div>
  )
}
