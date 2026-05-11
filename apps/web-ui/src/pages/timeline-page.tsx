import { memo, useMemo, useState } from 'react'
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

export function TimelinePage(props: {
  dashboard: DashboardModel | null
  loading: boolean
  appFilter: DashboardFilter
  selectedDate: string
  viewStartHour: number
  viewStartSec: number
  viewEndSec: number
  zoomHours: number
  setZoomHours: (hours: number) => void
  setViewStartHour: (hours: number) => void
}) {
  const [hoveredFocusSegmentId, setHoveredFocusSegmentId] = useState<string | null>(null)
  const visibleFocusItems = useMemo(
    () =>
      buildVisibleFocusItems(
        props.dashboard?.focusSegments ?? [],
        props.viewStartSec,
        props.viewEndSec,
      ),
    [props.dashboard?.focusSegments, props.viewEndSec, props.viewStartSec],
  )
  const browserDomainBySegmentId = useMemo(
    () => buildPrimaryBrowserDomainMap(visibleFocusItems, props.dashboard?.browserSegments ?? []),
    [props.dashboard?.browserSegments, visibleFocusItems],
  )
  const timelineRows = useMemo(
    () => [
      {
        id: 'focus',
        label: '应用',
        segments: props.dashboard?.focusSegments ?? [],
        selectedKey: props.appFilter?.key ?? null,
        splitByKey: false,
      },
      {
        id: 'presence',
        label: '状态',
        segments: props.dashboard?.presenceSegments ?? [],
        includeInTable: false,
      },
    ],
    [props.appFilter, props.dashboard?.focusSegments, props.dashboard?.presenceSegments],
  )
  const windowDurationSec = props.viewEndSec - props.viewStartSec
  const visibleAppCount = useMemo(
    () => new Set(visibleFocusItems.map((item) => item.key)).size,
    [visibleFocusItems],
  )
  const focusDurationSec = useMemo(
    () =>
      sumOverlappedDuration(
        props.dashboard?.focusSegments ?? [],
        props.viewStartSec,
        props.viewEndSec,
      ),
    [props.dashboard?.focusSegments, props.viewEndSec, props.viewStartSec],
  )
  const activeDurationSec = useMemo(
    () =>
      sumOverlappedDuration(
        (props.dashboard?.presenceSegments ?? []).filter((segment) => segment.key === 'active'),
        props.viewStartSec,
        props.viewEndSec,
      ),
    [props.dashboard?.presenceSegments, props.viewEndSec, props.viewStartSec],
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
                highlightedSegmentId={hoveredFocusSegmentId}
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
              focusSegments={props.dashboard?.focusSegments ?? []}
              presenceSegments={props.dashboard?.presenceSegments ?? []}
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
                  <span className="timeline-meta-pill">窗口内 {visibleFocusItems.length}</span>
                )}
              </div>
            </div>

            <div className="detail-list-section">
              <div className="detail-list-meta">
                <span>当前窗口</span>
                {props.loading ? (
                  <strong>
                    <span className="skeleton-block skeleton-inline skeleton-detail-count" />
                  </strong>
                ) : (
                  <strong>{visibleFocusItems.length}</strong>
                )}
              </div>
              <div className="detail-segment-scroll">
                {props.loading ? (
                  <DetailListSkeleton />
                ) : (
                  <FocusSegmentList
                    segments={visibleFocusItems}
                    browserDomainBySegmentId={browserDomainBySegmentId}
                    hoveredSegmentId={hoveredFocusSegmentId}
                    onHoverSegment={setHoveredFocusSegmentId}
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
  onHoverSegment: (segmentId: string | null) => void
}) {
  if (props.segments.length === 0) {
    return <div className="empty-card">暂无记录</div>
  }

  return (
    <div className="detail-segment-list">
      {props.segments.map((segment) => {
        return (
          <article
            key={segment.id}
            className={`detail-segment-item ${props.hoveredSegmentId === segment.id ? 'is-hovered' : ''}`}
            title={`${segment.label}\n${formatClockRange(segment.startSec, segment.endSec)}`}
            onMouseEnter={() => props.onHoverSegment(segment.id)}
            onMouseLeave={() => props.onHoverSegment(null)}
          >
            <span className="detail-segment-row">
              <span className="detail-segment-name">
                <i style={{ backgroundColor: segment.color }} />
                {segment.label}
              </span>
              {segment.isBrowser ? (
                <span className="detail-segment-domain">
                  {props.browserDomainBySegmentId.get(segment.id) ?? ''}
                </span>
              ) : null}
            </span>
            <span className="detail-segment-time">
              {formatClockRange(segment.startSec, segment.endSec)}
            </span>
          </article>
        )
      })}
    </div>
  )
})

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
