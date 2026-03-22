/* ActivityWatch-inspired timeline with stacked lanes, navigator, and detail table. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, PointerEvent as ReactPointerEvent, WheelEvent } from 'react'
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
  splitByKey?: boolean
  includeInOverview?: boolean
  includeInTable?: boolean
}

type RowLayout = {
  id: string
  label: string
  selectedKey?: string | null
  lanes: ChartSegment[][]
  includeInOverview: boolean
  includeInTable: boolean
}

type OverviewSegment = {
  id: string
  leftPct: number
  widthPct: number
  topPct: number
  heightPct: number
  color: string
  opacity: number
}

type InspectionItem = {
  id: string
  label: string
  detail: string
  color: string
  typeLabel: string
}

type DragState = {
  mode: 'move' | 'resize-start' | 'resize-end'
  startClientX: number
  startSec: number
  endSec: number
}

const DAY_SECONDS = 24 * 60 * 60
/** Viewport positions snap to 5-minute boundaries for a cleaner user experience. */
const SNAP_SECONDS = 5 * 60

export function TimelineChart(props: {
  rows: TimelineRow[]
  viewStartSec: number
  viewEndSec: number
  baseDate?: string
  selectedSegmentId?: string | null
  interactiveZoom?: boolean
  showTable?: boolean
  minViewHours?: number
  maxViewHours?: number
  onViewportChange?: (startSec: number, endSec: number) => void
  onSelectSegment?: (segment: ChartSegment) => void
}) {
  const overviewRef = useRef<HTMLDivElement | null>(null)
  const axisTrackRef = useRef<HTMLDivElement | null>(null)
  const laneTrackRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [hoveredSec, setHoveredSec] = useState<number | null>(null)
  const [hoveredAxisLeftPx, setHoveredAxisLeftPx] = useState<number | null>(null)
  const [hoveredLaneLeftPx, setHoveredLaneLeftPx] = useState<number | null>(null)
  const minZoomSec = Math.round((props.minViewHours ?? 1 / 12) * 3600)
  const maxZoomSec = Math.round((props.maxViewHours ?? 24) * 3600)
  const visibleDuration = props.viewEndSec - props.viewStartSec

  const layout = useMemo(() => buildRows(props.rows), [props.rows])
  const ticks = useMemo(
    () => buildTicks(props.viewStartSec, props.viewEndSec),
    [props.viewEndSec, props.viewStartSec],
  )
  const overviewSegments = useMemo(() => buildOverviewSegments(layout), [layout])
  const visibleItems = useMemo(
    () => buildVisibleItems(layout, props.viewStartSec, props.viewEndSec),
    [layout, props.viewEndSec, props.viewStartSec],
  )
  const inspectionItems = useMemo(
    () => (hoveredSec === null ? [] : buildInspectionItems(layout, hoveredSec)),
    [hoveredSec, layout],
  )

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const drag = dragStateRef.current
      const container = overviewRef.current

      if (!drag || !container || !props.onViewportChange) {
        return
      }

      const rect = container.getBoundingClientRect()
      if (rect.width <= 0) {
        return
      }

      const deltaSec = ((event.clientX - drag.startClientX) / rect.width) * DAY_SECONDS

      if (drag.mode === 'move') {
        const next = clampWindow(drag.startSec + deltaSec, drag.endSec + deltaSec, visibleDuration)
        props.onViewportChange(next.startSec, next.endSec)
        return
      }

      if (drag.mode === 'resize-start') {
        const proposedStart = snapToStep(drag.startSec + deltaSec)
        const minStart = Math.max(0, drag.endSec - maxZoomSec)
        const maxStart = Math.max(0, drag.endSec - minZoomSec)
        props.onViewportChange(clampNumber(proposedStart, minStart, maxStart), drag.endSec)
        return
      }

      const proposedEnd = snapToStep(drag.endSec + deltaSec)
      const minEnd = Math.min(DAY_SECONDS, drag.startSec + minZoomSec)
      const maxEnd = Math.min(DAY_SECONDS, drag.startSec + maxZoomSec)
      props.onViewportChange(drag.startSec, clampNumber(proposedEnd, minEnd, maxEnd))
    }

    function handlePointerUp() {
      dragStateRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [maxZoomSec, minZoomSec, props, visibleDuration])

  if (layout.length === 0) {
    return <div className="empty-card">没有可展示的时间线数据</div>
  }

  return (
    <section
      className="timeline-devtools"
      onPointerLeave={() => {
        setHoveredSec(null)
        setHoveredAxisLeftPx(null)
        setHoveredLaneLeftPx(null)
      }}
    >
      <div className="timeline-devtools-head">
        <div className="timeline-devtools-summary">
          <strong>
            {formatClock(props.viewStartSec)} - {formatClock(props.viewEndSec)}
          </strong>
          <span>滚轮滚动列表，Shift + 滚轮缩放，悬停定位时间点，拖动底部窗口平移</span>
        </div>

        {hoveredSec !== null ? (
          <div className="timeline-inspector-summary">
            <span className="timeline-inspector-time">{formatClock(hoveredSec)}</span>
            <div className="timeline-inspector-items">
              {inspectionItems.length > 0 ? (
                inspectionItems.map((item) => (
                  <span key={item.id} className="timeline-inspector-item" title={item.detail}>
                    <i style={{ backgroundColor: item.color }} />
                    <strong>{item.label}</strong>
                    <small>{item.typeLabel}</small>
                  </span>
                ))
              ) : (
                <span className="timeline-inspector-empty">该时刻没有记录</span>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="timeline-waterfall">
        <div className="timeline-axis">
          <div className="timeline-axis-label">名称</div>
          <div
            ref={axisTrackRef}
            className="timeline-axis-track"
            onPointerMove={(event) => {
              updateHoveredTime(
                event.clientX,
                axisTrackRef,
                laneTrackRef,
                props.viewStartSec,
                visibleDuration,
                setHoveredSec,
                setHoveredAxisLeftPx,
                setHoveredLaneLeftPx,
              )
            }}
          >
            {ticks.map((tick) => (
              <div
                key={`${tick.seconds}-${tick.label}`}
                className="timeline-axis-tick"
                style={{ left: `${tick.positionPct}%` }}
              >
                <span>{tick.label}</span>
              </div>
            ))}

            {hoveredAxisLeftPx !== null ? (
              <div
                className="timeline-inspector-axis-marker"
                style={{ left: `${hoveredAxisLeftPx}px` }}
              >
                <span>{formatClock(hoveredSec ?? props.viewStartSec)}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className="timeline-waterfall-body"
          onPointerMove={(event) => {
            updateHoveredTime(
              event.clientX,
              axisTrackRef,
              laneTrackRef,
              props.viewStartSec,
              visibleDuration,
              setHoveredSec,
              setHoveredAxisLeftPx,
              setHoveredLaneLeftPx,
            )
          }}
          onWheel={(event) =>
            handleTimelineWheel(event, {
              minZoomSec,
              maxZoomSec,
              viewStartSec: props.viewStartSec,
              viewEndSec: props.viewEndSec,
              onViewportChange: props.onViewportChange,
            })
          }
        >
          {layout.map((row, rowIndex) => (
            <div key={row.id} className="timeline-row-block">
              <div className="timeline-row-head">
                <strong>{row.label}</strong>
                {row.lanes.length > 1 ? <span>{row.lanes.length} 层</span> : null}
              </div>

              <div
                ref={rowIndex === 0 ? laneTrackRef : undefined}
                className="timeline-row-lanes"
              >
                {row.lanes.map((lane, laneIndex) => (
                  <div key={`${row.id}-lane-${laneIndex}`} className="timeline-lane">
                    {ticks.map((tick) => (
                      <span
                        key={`${row.id}-lane-${laneIndex}-${tick.seconds}`}
                        className="timeline-lane-grid"
                        style={{ left: `${tick.positionPct}%` }}
                      />
                    ))}

                    {lane.map((segment) => {
                      const clipped = clipSegment(segment, props.viewStartSec, props.viewEndSec)
                      if (!clipped) {
                        return null
                      }

                      const shouldDim =
                        row.selectedKey !== null &&
                        row.selectedKey !== undefined &&
                        row.selectedKey !== segment.key
                      const isSelected = props.selectedSegmentId === segment.id
                      const leftPct =
                        ((clipped.startSec - props.viewStartSec) / visibleDuration) * 100
                      const widthPct =
                        ((clipped.endSec - clipped.startSec) / visibleDuration) * 100

                      return (
                        <button
                          key={segment.id}
                          type="button"
                          className={`timeline-bar ${shouldDim ? 'is-dimmed' : ''} ${
                            isSelected ? 'is-selected' : ''
                          }`}
                          aria-label={buildTooltipText(segment)}
                          style={{
                            left: `${leftPct}%`,
                            width: `${Math.max(widthPct, 0.7)}%`,
                            backgroundColor: segment.color,
                          }}
                          title={buildTooltipText(segment)}
                          onClick={() => {
                            props.onSelectSegment?.(segment)
                          }}
                        />
                      )
                    })}
                  </div>
                ))}

                {hoveredLaneLeftPx !== null ? (
                  <span
                    className="timeline-inspector-line"
                    style={{ left: `${hoveredLaneLeftPx}px` }}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      {props.interactiveZoom ? (
        <div className="timeline-overview-panel">
          <div className="timeline-overview-head">
            <span>全天缩放</span>
            <span>{formatDuration(visibleDuration)}</span>
          </div>

          <div
            ref={overviewRef}
            className="timeline-overview"
            onPointerDown={(event) => {
              if (!props.onViewportChange) {
                return
              }

              const rect = overviewRef.current?.getBoundingClientRect()
              if (!rect) {
                return
              }

              const ratio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
              const centerSec = ratio * DAY_SECONDS
              const next = clampWindow(
                centerSec - visibleDuration / 2,
                centerSec + visibleDuration / 2,
                visibleDuration,
              )
              props.onViewportChange(next.startSec, next.endSec)
            }}
          >
            <div className="timeline-overview-grid" />

            {overviewSegments.map((segment) => (
              <span
                key={segment.id}
                className="timeline-overview-segment"
                style={{
                  left: `${segment.leftPct}%`,
                  width: `${segment.widthPct}%`,
                  top: `${segment.topPct}%`,
                  height: `${segment.heightPct}%`,
                  backgroundColor: segment.color,
                  opacity: segment.opacity,
                }}
              />
            ))}

            <div
              className="timeline-overview-window"
              style={{
                left: `${(props.viewStartSec / DAY_SECONDS) * 100}%`,
                width: `${Math.max((visibleDuration / DAY_SECONDS) * 100, 1.6)}%`,
              }}
              onPointerDown={(event) => beginOverviewDrag(event, 'move', props, dragStateRef)}
            >
              <button
                type="button"
                className="timeline-overview-handle is-start"
                aria-label="调整时间窗口开始位置"
                onPointerDown={(event) =>
                  beginOverviewDrag(event, 'resize-start', props, dragStateRef)
                }
              />
              <div className="timeline-overview-window-label">
                {formatClock(props.viewStartSec)} - {formatClock(props.viewEndSec)}
              </div>
              <button
                type="button"
                className="timeline-overview-handle is-end"
                aria-label="调整时间窗口结束位置"
                onPointerDown={(event) =>
                  beginOverviewDrag(event, 'resize-end', props, dragStateRef)
                }
              />
            </div>
          </div>
        </div>
      ) : null}

      {props.showTable ? (
        <div className="timeline-table">
          <div className="timeline-table-header">
            <span>名称</span>
            <span>类型</span>
            <span>说明</span>
            <span>时间段</span>
            <span>时长</span>
          </div>

          <div className="timeline-table-body">
            {visibleItems.map((item) => (
              <button
                key={`${item.id}-row`}
                type="button"
                className={`timeline-table-row ${item.id === props.selectedSegmentId ? 'is-selected' : ''}`}
                onClick={() => {
                  props.onSelectSegment?.(item)
                }}
              >
                <span className="timeline-table-name">
                  <i style={{ backgroundColor: item.color }} />
                  {item.label}
                </span>
                <span>{segmentTypeLabel(item)}</span>
                <span className="timeline-table-detail">{item.detail}</span>
                <span>{formatClockRange(item.startSec, item.endSec)}</span>
                <span>{formatDuration(item.durationSec)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function buildRows(rows: TimelineRow[]): RowLayout[] {
  return rows.flatMap((row) => {
    const shouldSplitByKey =
      row.splitByKey ??
      (row.segments.length > 0 &&
        (row.segments[0].tone === 'focus' || row.segments[0].tone === 'browser'))
    const includeInOverview = row.includeInOverview ?? true
    const includeInTable = row.includeInTable ?? true

    if (!shouldSplitByKey) {
      return [
        {
          id: row.id,
          label: row.label,
          selectedKey: row.selectedKey,
          lanes: buildLanes(row.segments),
          includeInOverview,
          includeInTable,
        },
      ]
    }

    const grouped = new Map<string, { label: string; segments: ChartSegment[]; total: number }>()

    for (const segment of row.segments) {
      const current = grouped.get(segment.key)
      if (current) {
        current.segments.push(segment)
        current.total += segment.durationSec
        continue
      }

      grouped.set(segment.key, {
        label: segment.label,
        segments: [segment],
        total: segment.durationSec,
      })
    }

    return Array.from(grouped.entries())
      .sort((left, right) => right[1].total - left[1].total)
      .map(([key, group]) => ({
        id: `${row.id}-${key}`,
        label: group.label,
        selectedKey: row.selectedKey,
        lanes: buildLanes(group.segments),
        includeInOverview,
        includeInTable,
      }))
  })
}

/**
 * Packs segments into the minimum number of non-overlapping lanes using a
 * greedy left-to-right algorithm: sort by start time, then place each segment
 * into the first lane whose last segment ends before this one starts.
 * If no lane fits, create a new one.
 */
function buildLanes(segments: ChartSegment[]) {
  const lanes: ChartSegment[][] = []
  const ordered = [...segments].sort((left, right) => {
    if (left.startSec !== right.startSec) {
      return left.startSec - right.startSec
    }

    return left.endSec - right.endSec
  })

  for (const segment of ordered) {
    let placed = false

    for (const lane of lanes) {
      const last = lane[lane.length - 1]
      if (last.endSec <= segment.startSec) {
        lane.push(segment)
        placed = true
        break
      }
    }

    if (!placed) {
      lanes.push([segment])
    }
  }

  return lanes.length > 0 ? lanes : [[]]
}

function buildTicks(viewStartSec: number, viewEndSec: number) {
  const duration = viewEndSec - viewStartSec
  const step = chooseTickStep(duration)
  const first = Math.floor(viewStartSec / step) * step
  const ticks: Array<{ seconds: number; label: string; positionPct: number }> = []

  for (let value = first; value <= viewEndSec; value += step) {
    const seconds = clampNumber(value, viewStartSec, viewEndSec)
    ticks.push({
      seconds,
      label: formatTickLabel(seconds, duration),
      positionPct: ((seconds - viewStartSec) / duration) * 100,
    })
  }

  return ticks
}

function buildOverviewSegments(rows: RowLayout[]): OverviewSegment[] {
  const overviewRows = rows.filter((row) => row.includeInOverview)
  const totalRows = Math.max(overviewRows.length, 1)

  return overviewRows.flatMap((row, rowIndex) =>
    row.lanes.flatMap((lane, laneIndex) =>
      lane.map((segment) => ({
        id: `${segment.id}-overview`,
        leftPct: (segment.startSec / DAY_SECONDS) * 100,
        widthPct: Math.max((segment.durationSec / DAY_SECONDS) * 100, 0.2),
        // Distribute rows vertically within the overview bar. The +6 top offset
        // and 18% base height keep segments visually centered in the panel.
        topPct: ((rowIndex + laneIndex / Math.max(row.lanes.length, 1)) / totalRows) * 100 + 6,
        heightPct: 18 / totalRows,
        color: segment.color,
        opacity: 0.82,
      })),
    ),
  )
}

function buildVisibleItems(rows: RowLayout[], viewStartSec: number, viewEndSec: number) {
  return rows
    .filter((row) => row.includeInTable)
    .flatMap((row) => row.lanes.flatMap((lane) => lane))
    .filter((segment) => segment.endSec > viewStartSec && segment.startSec < viewEndSec)
    .sort((left, right) => {
      if (left.startSec !== right.startSec) {
        return left.startSec - right.startSec
      }

      return right.durationSec - left.durationSec
    })
}

function buildInspectionItems(rows: RowLayout[], seconds: number): InspectionItem[] {
  return rows
    .filter((row) => row.includeInTable)
    .map((row) => findSegmentAtTime(row, seconds))
    .filter((segment): segment is ChartSegment => segment !== null)
    .map((segment) => ({
      id: `${segment.id}-inspection`,
      label: segment.label,
      detail: segment.detail,
      color: segment.color,
      typeLabel: segmentTypeLabel(segment),
    }))
}

function findSegmentAtTime(row: RowLayout, seconds: number) {
  for (const lane of row.lanes) {
    for (const segment of lane) {
      if (segment.startSec <= seconds && seconds < segment.endSec) {
        return segment
      }
    }
  }

  return null
}

function clipSegment(segment: ChartSegment, viewStartSec: number, viewEndSec: number) {
  const startSec = Math.max(segment.startSec, viewStartSec)
  const endSec = Math.min(segment.endSec, viewEndSec)

  if (endSec <= startSec) {
    return null
  }

  return {
    startSec,
    endSec,
  }
}

function beginOverviewDrag(
  event: ReactPointerEvent<HTMLElement>,
  mode: DragState['mode'],
  props: {
    viewStartSec: number
    viewEndSec: number
  },
  dragStateRef: MutableRefObject<DragState | null>,
) {
  event.preventDefault()
  event.stopPropagation()
  dragStateRef.current = {
    mode,
    startClientX: event.clientX,
    startSec: props.viewStartSec,
    endSec: props.viewEndSec,
  }
}

function updateHoveredTime(
  clientX: number,
  trackRef: MutableRefObject<HTMLDivElement | null>,
  laneTrackRef: MutableRefObject<HTMLDivElement | null>,
  viewStartSec: number,
  visibleDuration: number,
  setHoveredSec: (seconds: number | null) => void,
  setHoveredAxisLeftPx: (value: number | null) => void,
  setHoveredLaneLeftPx: (value: number | null) => void,
) {
  const rect = trackRef.current?.getBoundingClientRect()
  if (!rect || rect.width <= 0) {
    return
  }

  if (clientX < rect.left || clientX > rect.right) {
    setHoveredSec(null)
    setHoveredAxisLeftPx(null)
    setHoveredLaneLeftPx(null)
    return
  }

  const ratio = clampNumber((clientX - rect.left) / rect.width, 0, 1)
  setHoveredSec(viewStartSec + ratio * visibleDuration)
  setHoveredAxisLeftPx(clampNumber(clientX - rect.left, 0, rect.width))

  const laneRect = laneTrackRef.current?.getBoundingClientRect()
  if (!laneRect || laneRect.width <= 0) {
    setHoveredLaneLeftPx(null)
    return
  }

  setHoveredLaneLeftPx(clampNumber(clientX - laneRect.left, 0, laneRect.width))
}

function handleTimelineWheel(
  event: WheelEvent<HTMLDivElement>,
  options: {
    minZoomSec: number
    maxZoomSec: number
    viewStartSec: number
    viewEndSec: number
    onViewportChange?: (startSec: number, endSec: number) => void
  },
) {
  const shouldZoom = event.shiftKey || event.ctrlKey || event.metaKey

  if (!shouldZoom || !options.onViewportChange) {
    return
  }

  event.preventDefault()
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
  const currentDuration = options.viewEndSec - options.viewStartSec
  const factor = event.deltaY > 0 ? 1.14 : 0.86
  const nextDuration = clampNumber(
    snapToStep(currentDuration * factor),
    options.minZoomSec,
    options.maxZoomSec,
  )
  const anchorSec = options.viewStartSec + ratio * currentDuration
  const nextStart = anchorSec - ratio * nextDuration
  const next = clampWindow(nextStart, nextStart + nextDuration, nextDuration)
  options.onViewportChange(next.startSec, next.endSec)
}

function clampWindow(startSec: number, endSec: number, duration: number) {
  let nextStart = startSec
  let nextEnd = endSec

  if (nextStart < 0) {
    nextStart = 0
    nextEnd = duration
  }

  if (nextEnd > DAY_SECONDS) {
    nextEnd = DAY_SECONDS
    nextStart = DAY_SECONDS - duration
  }

  return {
    startSec: snapToStep(nextStart),
    endSec: snapToStep(nextEnd),
  }
}

/** Picks a tick interval that yields ~4-8 visible ticks for the given duration. */
function chooseTickStep(duration: number) {
  if (duration <= 15 * 60) {        // ≤15min → tick every 1 min
    return 60
  }
  if (duration <= 60 * 60) {        // ≤1h → tick every 5 min
    return 5 * 60
  }
  if (duration <= 2 * 60 * 60) {    // ≤2h → tick every 15 min
    return 15 * 60
  }
  if (duration <= 8 * 60 * 60) {    // ≤8h → tick every 1h
    return 60 * 60
  }
  return 2 * 60 * 60               // >8h → tick every 2h
}

function formatTickLabel(seconds: number, duration: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (duration <= 15 * 60) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
  }

  return `${pad(hours)}:${pad(minutes)}`
}

function formatClock(seconds: number) {
  const clamped = clampNumber(seconds, 0, DAY_SECONDS)
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  return `${pad(hours)}:${pad(minutes)}`
}

function pad(value: number) {
  return `${value}`.padStart(2, '0')
}

function snapToStep(seconds: number) {
  return Math.round(seconds / SNAP_SECONDS) * SNAP_SECONDS
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function buildTooltipText(segment: ChartSegment) {
  return [
    segment.label,
    segment.detail,
    formatClockRange(segment.startSec, segment.endSec),
    formatDuration(segment.durationSec),
  ].join('\n')
}

function segmentTypeLabel(segment: ChartSegment) {
  if (segment.tone === 'presence') {
    return '状态'
  }

  if (segment.tone === 'browser') {
    return '域名'
  }

  return segment.isBrowser ? '浏览器' : '应用'
}
