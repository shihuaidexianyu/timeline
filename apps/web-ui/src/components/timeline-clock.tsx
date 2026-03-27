import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { ChartSegment } from '../lib/chart-model'
import { formatDuration } from '../lib/chart-model'

const DAY_SECONDS = 24 * 60 * 60
const CLOCK_SIZE = 292
const CLOCK_CENTER = CLOCK_SIZE / 2
const OUTER_RING_RADIUS = 116
const INNER_RING_RADIUS = 100
const WINDOW_RING_RADIUS = 84
const CONTROL_RING_RADIUS = 136
const MOVE_CONTROL_RING_RADIUS = 152
const HANDLE_PRIORITY_RADIUS = 26

type DragMode = 'resize' | 'move' | null

export function TimelineClock(props: {
    loading?: boolean
    focusSegments: ChartSegment[]
    presenceSegments: ChartSegment[]
    viewStartSec: number
    viewEndSec: number
    minViewSec: number
    maxViewSec: number
    onWindowChange: (startSec: number, endSec: number) => void
}) {
    const { loading, minViewSec, maxViewSec, onWindowChange } = props
    const svgRef = useRef<SVGSVGElement | null>(null)
    const dragModeRef = useRef<DragMode>(null)
    const moveCenterOffsetRef = useRef(0)
    const resizeCenterSecRef = useRef(0)
    const dragLastRawSecRef = useRef(0)
    const dragWrapOffsetRef = useRef(0)
    const [isDragging, setIsDragging] = useState(false)

    const focusArcs = useMemo(
        () => toArcs(props.focusSegments, OUTER_RING_RADIUS, 9),
        [props.focusSegments],
    )
    const presenceArcs = useMemo(
        () => toArcs(props.presenceSegments, INNER_RING_RADIUS, 7),
        [props.presenceSegments],
    )

    const windowDuration = Math.max(0, props.viewEndSec - props.viewStartSec)

    // Calculate window center for move handle position
    const windowCenterSecRaw = props.viewStartSec + windowDuration / 2

    const windowStartPoint = pointAtSec(props.viewStartSec, CONTROL_RING_RADIUS)
    const windowEndPoint = pointAtSec(props.viewEndSec, CONTROL_RING_RADIUS)
    // Use raw center + offset for move handle
    const moveHandlePoint = pointAtSec(windowCenterSecRaw + DAY_SECONDS / 2, MOVE_CONTROL_RING_RADIUS)

    // Detect boundary limit states
    const isAtMinDuration = windowDuration <= minViewSec + 60 // 1min tolerance
    const isAtMaxDuration = windowDuration >= maxViewSec - 60
    const isAtStartBoundary = props.viewStartSec <= 300 // 5min from 0:00
    const isAtEndBoundary = props.viewEndSec >= DAY_SECONDS - 300 // 5min to 24:00
    const isAtLimits = isAtMinDuration || isAtMaxDuration || isAtStartBoundary || isAtEndBoundary

    useEffect(() => {
        if (loading) {
            return
        }

        function handlePointerMove(event: PointerEvent) {
            const mode = dragModeRef.current
            const svg = svgRef.current
            if (!mode || !svg) {
                return
            }

            const rawSec = secFromPointer(event.clientX, event.clientY, svg)
            const continuousSec = toContinuousSec(rawSec, dragLastRawSecRef, dragWrapOffsetRef)
            const nextSec = continuousSec
            if (mode === 'move') {
                const half = windowDuration / 2

                // Calculate next center position
                const nextCenter = nextSec + moveCenterOffsetRef.current

                // Position window around center
                let nextStart = nextCenter - half

                // Strictly clamp to [0, DAY_SECONDS - windowDuration]
                // No wraparound allowed - prevent crossing midnight
                nextStart = clamp(nextStart, 0, DAY_SECONDS - windowDuration)

                onWindowChange(nextStart, nextStart + windowDuration)
                return
            }

            const resizeCenterSec = resizeCenterSecRef.current
            const halfDuration = Math.abs(nextSec - resizeCenterSec)
            const maxSymmetricDuration = Math.max(
                minViewSec,
                Math.min(
                    maxViewSec,
                    2 * Math.min(resizeCenterSec, DAY_SECONDS - resizeCenterSec),
                ),
            )
            const duration = clamp(halfDuration * 2, minViewSec, maxSymmetricDuration)
            const nextStart = resizeCenterSec - duration / 2
            onWindowChange(nextStart, nextStart + duration)
        }

        function handlePointerUp() {
            dragModeRef.current = null
            moveCenterOffsetRef.current = 0
            dragWrapOffsetRef.current = 0
            setIsDragging(false)
        }

        window.addEventListener('pointermove', handlePointerMove)
        window.addEventListener('pointerup', handlePointerUp)
        window.addEventListener('pointercancel', handlePointerUp)

        return () => {
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', handlePointerUp)
            window.removeEventListener('pointercancel', handlePointerUp)
        }
    }, [
        loading,
        maxViewSec,
        minViewSec,
        onWindowChange,
        windowDuration,
    ])

    if (loading) {
        return (
            <div className="timeline-clock-card timeline-clock-card-skeleton" aria-hidden="true">
                <div className="timeline-clock-shell timeline-clock-shell-skeleton">
                    <span className="skeleton-block timeline-clock-face-skeleton" />
                </div>
                <div className="timeline-clock-footer timeline-clock-footer-skeleton">
                    <div className="timeline-clock-center timeline-clock-center-skeleton">
                        <span className="skeleton-block skeleton-inline skeleton-clock-title" />
                        <span className="skeleton-block skeleton-inline skeleton-clock-subtitle" />
                    </div>
                    <div className="timeline-clock-instruction timeline-clock-instruction-skeleton">
                        <span className="skeleton-block skeleton-inline skeleton-clock-copy" />
                        <span className="skeleton-block skeleton-inline skeleton-clock-copy skeleton-clock-copy-short" />
                    </div>
                </div>
            </div>
        )
    }

    function beginResizeDrag(event: ReactPointerEvent<SVGElement>) {
        event.preventDefault()
        event.stopPropagation()
        const svg = svgRef.current
        if (!svg) {
            return
        }
        const rawSec = secFromPointer(event.clientX, event.clientY, svg)
        dragLastRawSecRef.current = rawSec
        dragWrapOffsetRef.current = 0
        const centerSec = (props.viewStartSec + props.viewEndSec) / 2
        resizeCenterSecRef.current = nearestEquivalentSec(centerSec, rawSec)
        dragModeRef.current = 'resize'
        setIsDragging(true)
    }

    function beginMoveDrag(event: ReactPointerEvent<SVGElement>) {
        event.preventDefault()
        event.stopPropagation()
        const svg = svgRef.current
        if (!svg) {
            return
        }

        const pointerPoint = pointFromPointer(event.clientX, event.clientY, svg)
        const nearStartHandle = distanceBetween(pointerPoint, windowStartPoint) <= HANDLE_PRIORITY_RADIUS
        const nearEndHandle = distanceBetween(pointerPoint, windowEndPoint) <= HANDLE_PRIORITY_RADIUS
        if (nearStartHandle || nearEndHandle) {
            beginResizeDrag(event)
            return
        }

        const pointerSec = secFromPointer(event.clientX, event.clientY, svg)
        dragLastRawSecRef.current = pointerSec
        dragWrapOffsetRef.current = 0
        const centerSec = (props.viewStartSec + props.viewEndSec) / 2
        moveCenterOffsetRef.current = centerSec - pointerSec
        dragModeRef.current = 'move'
        setIsDragging(true)
    }

    return (
        <div className={`timeline-clock-card ${isDragging ? 'is-dragging' : ''}`}>
            <div className="timeline-clock-shell">
                <svg
                    ref={svgRef}
                    viewBox={`0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}`}
                    className="timeline-clock-svg"
                >
                    <circle cx={CLOCK_CENTER} cy={CLOCK_CENTER} r={124} className="timeline-clock-base" />

                    <circle
                        cx={CLOCK_CENTER}
                        cy={CLOCK_CENTER}
                        r={CONTROL_RING_RADIUS}
                        className="timeline-clock-move-hit-ring"
                        onPointerDown={beginMoveDrag}
                    />

                    <circle
                        cx={CLOCK_CENTER}
                        cy={CLOCK_CENTER}
                        r={72}
                        className="timeline-clock-center-hit"
                        onPointerDown={beginMoveDrag}
                    />

                    {buildHourTicks().map((tick) => (
                        <line
                            key={`tick-${tick.hour}`}
                            x1={tick.x1}
                            y1={tick.y1}
                            x2={tick.x2}
                            y2={tick.y2}
                            className={`timeline-clock-tick ${tick.major ? 'is-major' : ''}`}
                        />
                    ))}

                    {focusArcs.map((arc) => (
                        <path
                            key={`focus-${arc.id}`}
                            d={arc.path}
                            stroke={arc.color}
                            strokeWidth={arc.strokeWidth}
                            className="timeline-clock-arc focus"
                        />
                    ))}

                    {presenceArcs.map((arc) => (
                        <path
                            key={`presence-${arc.id}`}
                            d={arc.path}
                            stroke={arc.color}
                            strokeWidth={arc.strokeWidth}
                            className="timeline-clock-arc presence"
                        />
                    ))})

                    <path
                        d={windowSectorPath(props.viewStartSec, props.viewEndSec, 0, 124)}
                        className="timeline-clock-window-sector"
                    />

                    <path
                        d={arcPath(props.viewStartSec, props.viewEndSec, WINDOW_RING_RADIUS)}
                        className="timeline-clock-window-hit-arc"
                        onPointerDown={beginMoveDrag}
                    />

                    <line
                        x1={CLOCK_CENTER}
                        y1={CLOCK_CENTER}
                        x2={windowStartPoint.x}
                        y2={windowStartPoint.y}
                        className="timeline-clock-window-pointer is-start"
                    />
                    <line
                        x1={CLOCK_CENTER}
                        y1={CLOCK_CENTER}
                        x2={windowEndPoint.x}
                        y2={windowEndPoint.y}
                        className="timeline-clock-window-pointer is-end"
                    />

                    <circle
                        cx={CLOCK_CENTER}
                        cy={CLOCK_CENTER}
                        r={3.5}
                        className="timeline-clock-origin-dot"
                    />

                    <circle
                        cx={windowStartPoint.x}
                        cy={windowStartPoint.y}
                        r={8}
                        className={`timeline-clock-handle is-window-endpoint ${isAtLimits ? 'is-at-limit' : ''}`}
                        onPointerDown={beginResizeDrag}
                    />
                    <circle
                        cx={windowStartPoint.x}
                        cy={windowStartPoint.y}
                        r={30}
                        className="timeline-clock-handle-hit is-window-endpoint-hit"
                        onPointerDown={beginResizeDrag}
                    />
                    <circle
                        cx={windowEndPoint.x}
                        cy={windowEndPoint.y}
                        r={8}
                        className={`timeline-clock-handle is-window-endpoint ${isAtLimits ? 'is-at-limit' : ''}`}
                        onPointerDown={beginResizeDrag}
                    />
                    <circle
                        cx={windowEndPoint.x}
                        cy={windowEndPoint.y}
                        r={30}
                        className="timeline-clock-handle-hit is-window-endpoint-hit"
                        onPointerDown={beginResizeDrag}
                    />

                    <line
                        x1={CLOCK_CENTER}
                        y1={CLOCK_CENTER}
                        x2={moveHandlePoint.x}
                        y2={moveHandlePoint.y}
                        className="timeline-clock-bisector"
                    />

                    <polygon
                        points={`${moveHandlePoint.x},${moveHandlePoint.y - 10} ${moveHandlePoint.x + 10},${moveHandlePoint.y} ${moveHandlePoint.x},${moveHandlePoint.y + 10} ${moveHandlePoint.x - 10},${moveHandlePoint.y}`}
                        className="timeline-clock-handle is-move"
                        onPointerDown={beginMoveDrag}
                    />
                    <circle
                        cx={moveHandlePoint.x}
                        cy={moveHandlePoint.y}
                        r={30}
                        className="timeline-clock-handle-hit is-move-hit"
                        onPointerDown={beginMoveDrag}
                    />

                    {buildHourLabels().map((label) => (
                        <text
                            key={`label-${label.hour}`}
                            x={label.x}
                            y={label.y}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            className="timeline-clock-hour-label"
                        >
                            {label.text}
                        </text>
                    ))}
                </svg>
            </div>

            <div className="timeline-clock-footer">
                <div className="timeline-clock-center">
                    <strong>{formatClock(props.viewStartSec)} - {formatClock(props.viewEndSec)}</strong>
                    <small>{formatDuration(windowDuration)}</small>
                </div>
                <p className="timeline-clock-instruction">
                    操作说明：双指针端点柄用于缩放；角平分线对端柄用于平移；红色表示到达限位。
                </p>
            </div>
        </div>
    )
}

type ArcDatum = {
    id: string
    path: string
    color: string
    strokeWidth: number
}

function toArcs(segments: ChartSegment[], radius: number, strokeWidth: number): ArcDatum[] {
    return segments
        .filter((segment) => segment.endSec > segment.startSec)
        .map((segment) => ({
            id: segment.id,
            path: arcPath(segment.startSec, segment.endSec, radius),
            color: segment.color,
            strokeWidth,
        }))
}

function buildHourTicks() {
    return Array.from({ length: 24 }, (_, hour) => {
        const sec = hour * 3600
        const outer = pointAtSec(sec, 128)
        const inner = pointAtSec(sec, hour % 3 === 0 ? 118 : 122)
        return {
            hour,
            x1: outer.x,
            y1: outer.y,
            x2: inner.x,
            y2: inner.y,
            major: hour % 3 === 0,
        }
    })
}

function buildHourLabels() {
    return [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => {
        const point = pointAtSec(hour * 3600, 137)
        return {
            hour,
            text: `${String(hour).padStart(2, '0')}`,
            x: point.x,
            y: point.y,
        }
    })
}

function arcPath(startSec: number, endSec: number, radius: number) {
    const normalStart = normalizeSec(startSec)
    const normalEnd = normalizeSec(endSec)

    let duration: number
    if (normalEnd >= normalStart) {
        duration = normalEnd - normalStart
    } else {
        duration = (DAY_SECONDS - normalStart) + normalEnd
    }

    if (duration <= 0) {
        return ''
    }

    const start = pointAtSec(normalStart, radius)
    const end = pointAtSec(normalEnd, radius)
    const largeArc = duration > DAY_SECONDS / 2 ? 1 : 0

    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

function pointAtSec(seconds: number, radius: number) {
    const angle = secToAngle(seconds)
    return {
        x: CLOCK_CENTER + radius * Math.cos(angle),
        y: CLOCK_CENTER + radius * Math.sin(angle),
    }
}

function secToAngle(seconds: number) {
    const ratio = normalizeSec(seconds) / DAY_SECONDS
    return ratio * Math.PI * 2 - Math.PI / 2
}

function secFromPointer(clientX: number, clientY: number, svg: SVGSVGElement) {
    const rect = svg.getBoundingClientRect()
    const x = clientX - rect.left - rect.width / 2
    const y = clientY - rect.top - rect.height / 2
    const angle = Math.atan2(y, x) + Math.PI / 2
    const normalized = angle < 0 ? angle + Math.PI * 2 : angle
    return (normalized / (Math.PI * 2)) * DAY_SECONDS
}

function formatClock(seconds: number) {
    const clamped = clamp(seconds, 0, DAY_SECONDS)
    const hours = Math.floor(clamped / 3600)
    const minutes = Math.floor((clamped % 3600) / 60)
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(value, max))
}

function normalizeSec(seconds: number) {
    const mod = seconds % DAY_SECONDS
    return mod < 0 ? mod + DAY_SECONDS : mod
}

function toContinuousSec(rawSec: number, lastRawRef: { current: number }, wrapOffsetRef: { current: number }) {
    const delta = rawSec - lastRawRef.current
    if (delta > DAY_SECONDS / 2) {
        wrapOffsetRef.current -= DAY_SECONDS
    } else if (delta < -DAY_SECONDS / 2) {
        wrapOffsetRef.current += DAY_SECONDS
    }
    lastRawRef.current = rawSec
    return rawSec + wrapOffsetRef.current
}

function nearestEquivalentSec(baseSec: number, aroundSec: number) {
    const candidates = [baseSec - DAY_SECONDS, baseSec, baseSec + DAY_SECONDS]
    let best = candidates[0]
    let bestDistance = Math.abs(candidates[0] - aroundSec)
    for (let index = 1; index < candidates.length; index += 1) {
        const distance = Math.abs(candidates[index] - aroundSec)
        if (distance < bestDistance) {
            best = candidates[index]
            bestDistance = distance
        }
    }
    return best
}

function pointFromPointer(clientX: number, clientY: number, svg: SVGSVGElement) {
    const rect = svg.getBoundingClientRect()
    const x = (clientX - rect.left) * (CLOCK_SIZE / rect.width)
    const y = (clientY - rect.top) * (CLOCK_SIZE / rect.height)
    return { x, y }
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return Math.hypot(dx, dy)
}

function windowSectorPath(startSec: number, endSec: number, innerRadius: number, outerRadius: number) {
    const normalStart = normalizeSec(startSec)
    const normalEnd = normalizeSec(endSec)

    let duration: number
    if (normalEnd >= normalStart) {
        duration = normalEnd - normalStart
    } else {
        duration = (DAY_SECONDS - normalStart) + normalEnd
    }

    if (duration <= 0) {
        return ''
    }

    const startInner = pointAtSec(normalStart, innerRadius)
    const startOuter = pointAtSec(normalStart, outerRadius)
    const endInner = pointAtSec(normalEnd, innerRadius)
    const endOuter = pointAtSec(normalEnd, outerRadius)
    const largeArc = duration > DAY_SECONDS / 2 ? 1 : 0

    // Sector path: outer arc, line to inner end, inner arc back, close
    return `M ${startOuter.x} ${startOuter.y} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${endOuter.x} ${endOuter.y} L ${endInner.x} ${endInner.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${startInner.x} ${startInner.y} Z`
}
