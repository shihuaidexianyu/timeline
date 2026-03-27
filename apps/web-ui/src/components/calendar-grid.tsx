/* Compact month heatmap that uses color depth to represent daily active time. */

import { useMemo } from 'react'
import type { DaySummary } from '../api'
import { formatDuration } from '../lib/chart-model'

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const HEAT_CLASSES = [
  'calendar-heat-0',
  'calendar-heat-1',
  'calendar-heat-2',
  'calendar-heat-3',
  'calendar-heat-4',
] as const

export function CalendarGrid(props: {
  loading?: boolean
  month: string
  days: DaySummary[]
  selectedDate: string
  todayDate: string | null
  onSelectDate: (date: string) => void
  onMonthChange: (month: string) => void
}) {
  const cells = useMemo(() => buildCalendarCells(props.month, props.days), [props.month, props.days])
  const selectedSummary = useMemo(
    () => props.days.find((day) => day.date === props.selectedDate) ?? null,
    [props.days, props.selectedDate],
  )
  const monthSummary = useMemo(() => buildMonthSummary(props.days), [props.days])

  if (props.loading) {
    return (
      <div className="calendar-panel calendar-panel-compact calendar-panel-skeleton" aria-hidden="true">
        <div className="calendar-header">
          <span className="skeleton-block calendar-nav-button calendar-nav-button-skeleton" />
          <div className="calendar-header-copy calendar-header-copy-skeleton">
            <span className="skeleton-block skeleton-inline skeleton-calendar-title" />
            <span className="skeleton-block skeleton-inline skeleton-calendar-subtitle" />
          </div>
          <span className="skeleton-block calendar-nav-button calendar-nav-button-skeleton" />
        </div>

        <div className="calendar-grid calendar-grid-compact">
          {Array.from({ length: 7 }, (_, index) => (
            <span key={`weekday-skeleton-${index}`} className="skeleton-block skeleton-inline skeleton-calendar-weekday" />
          ))}

          {Array.from({ length: 35 }, (_, index) => (
            <span
              key={`calendar-cell-skeleton-${index}`}
              className="calendar-cell calendar-cell-compact calendar-cell-skeleton"
            />
          ))}
        </div>

        <div className="calendar-legend calendar-legend-skeleton">
          <span className="skeleton-block skeleton-inline skeleton-calendar-legend-label" />
          <div className="calendar-legend-swatches" aria-hidden="true">
            {HEAT_CLASSES.map((heatClass) => (
              <i key={`legend-${heatClass}`} className={`calendar-legend-swatch ${heatClass} calendar-legend-swatch-skeleton`} />
            ))}
          </div>
          <span className="skeleton-block skeleton-inline skeleton-calendar-legend-label" />
        </div>

        <div className="calendar-selection-summary calendar-selection-summary-skeleton">
          <span className="skeleton-block skeleton-inline skeleton-calendar-selection-title" />
          <span className="skeleton-block skeleton-inline skeleton-calendar-selection-copy" />
        </div>
      </div>
    )
  }

  return (
    <div className="calendar-panel calendar-panel-compact">
      <div className="calendar-header">
        <button
          type="button"
          className="calendar-nav-button"
          aria-label="上一月"
          onClick={() => props.onMonthChange(shiftMonth(props.month, -1))}
        >
          ‹
        </button>
        <div className="calendar-header-copy">
          <strong className="calendar-month-label">{props.month}</strong>
          <small>
            本月活跃 {formatDuration(monthSummary.totalActiveSeconds)} · {monthSummary.activeDays} 天
          </small>
        </div>
        <button
          type="button"
          className="calendar-nav-button"
          aria-label="下一月"
          onClick={() => props.onMonthChange(shiftMonth(props.month, 1))}
        >
          ›
        </button>
      </div>

      <div className="calendar-grid calendar-grid-compact">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="calendar-weekday">
            {label}
          </div>
        ))}

        {cells.map((cell) => {
          if (!cell.date) {
            return <div key={cell.key} className="calendar-cell calendar-cell-compact is-empty" />
          }

          const isSelected = cell.date === props.selectedDate
          const isToday = props.todayDate !== null && cell.date === props.todayDate

          return (
            <button
              key={cell.key}
              type="button"
              className={`calendar-cell calendar-cell-compact ${cell.heatClass} ${
                isSelected ? 'is-selected' : ''
              } ${isToday ? 'is-today' : ''}`}
              aria-label={cell.tooltip}
              title={cell.tooltip}
              onClick={() => props.onSelectDate(cell.date!)}
            >
              <span className="calendar-day-number">{cell.dayNumber}</span>
            </button>
          )
        })}
      </div>

      <div className="calendar-legend">
        <span>少</span>
        <div className="calendar-legend-swatches" aria-hidden="true">
          {HEAT_CLASSES.map((heatClass) => (
            <i key={heatClass} className={`calendar-legend-swatch ${heatClass}`} />
          ))}
        </div>
        <span>多</span>
      </div>

      <div className="calendar-selection-summary">
        <strong>{props.selectedDate}</strong>
        <span>
          {selectedSummary
            ? `活跃 ${formatDuration(selectedSummary.active_seconds)}`
            : '暂无活动记录'}
        </span>
      </div>
    </div>
  )
}

type CalendarCell = {
  key: string
  date: string | null
  dayNumber: number | null
  heatClass: string
  tooltip: string
}

function buildCalendarCells(month: string, days: DaySummary[]): CalendarCell[] {
  const [yearStr, monthStr] = month.split('-')
  const year = Number(yearStr)
  const monthNum = Number(monthStr)

  const firstDay = new Date(Date.UTC(year, monthNum - 1, 1))
  const startWeekday = (firstDay.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
  const dayMap = new Map(days.map((day) => [day.date, day]))
  const maxActive = Math.max(...days.map((day) => day.active_seconds), 0)
  const cells: CalendarCell[] = []

  for (let index = 0; index < startWeekday; index += 1) {
    cells.push({
      key: `empty-start-${index}`,
      date: null,
      dayNumber: null,
      heatClass: '',
      tooltip: '',
    })
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${yearStr}-${monthStr}-${String(day).padStart(2, '0')}`
    const summary = dayMap.get(date)
    const activeSeconds = summary?.active_seconds ?? 0
    const heatLevel = maxActive > 0 ? heatTier(activeSeconds, maxActive) : 0
    const tooltipLines = [date, `活跃: ${formatDuration(activeSeconds)}`]

    cells.push({
      key: date,
      date,
      dayNumber: day,
      heatClass: HEAT_CLASSES[heatLevel],
      tooltip: tooltipLines.join('\n'),
    })
  }

  const trailing = (7 - (cells.length % 7)) % 7
  for (let index = 0; index < trailing; index += 1) {
    cells.push({
      key: `empty-end-${index}`,
      date: null,
      dayNumber: null,
      heatClass: '',
      tooltip: '',
    })
  }

  return cells
}

function heatTier(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  const ratio = value / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

function shiftMonth(month: string, delta: number): string {
  const [yearStr, monthStr] = month.split('-')
  let year = Number(yearStr)
  let nextMonth = Number(monthStr) + delta

  while (nextMonth < 1) {
    year -= 1
    nextMonth += 12
  }

  while (nextMonth > 12) {
    year += 1
    nextMonth -= 12
  }

  return `${year}-${String(nextMonth).padStart(2, '0')}`
}

function buildMonthSummary(days: DaySummary[]) {
  return {
    totalActiveSeconds: days.reduce((sum, day) => sum + day.active_seconds, 0),
    activeDays: days.filter((day) => day.active_seconds > 0).length,
  }
}
