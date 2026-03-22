/* Month calendar heatmap grid with per-day activity summaries and date selection. */

import { useMemo } from 'react'
import type { DaySummary } from '../api'
import { formatDuration, todayString } from '../lib/chart-model'

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 5-tier heatmap colors from lightest to deepest blue. */
const HEAT_CLASSES = [
  'calendar-heat-0',
  'calendar-heat-1',
  'calendar-heat-2',
  'calendar-heat-3',
  'calendar-heat-4',
] as const

export function CalendarGrid(props: {
  month: string
  days: DaySummary[]
  selectedDate: string
  onSelectDate: (date: string) => void
  onMonthChange: (month: string) => void
}) {
  const cells = useMemo(
    () => buildCalendarCells(props.month, props.days),
    [props.month, props.days],
  )
  const todayStr = todayString()

  return (
    <div className="calendar-panel">
      <div className="calendar-header">
        <button
          type="button"
          className="calendar-nav-button"
          onClick={() => props.onMonthChange(shiftMonth(props.month, -1))}
        >
          ‹
        </button>
        <strong className="calendar-month-label">{props.month}</strong>
        <button
          type="button"
          className="calendar-nav-button"
          onClick={() => props.onMonthChange(shiftMonth(props.month, 1))}
        >
          ›
        </button>
      </div>

      <div className="calendar-grid">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="calendar-weekday">
            {label}
          </div>
        ))}

        {cells.map((cell) => {
          if (!cell.date) {
            return <div key={cell.key} className="calendar-cell is-empty" />
          }

          const isSelected = cell.date === props.selectedDate
          const isToday = cell.date === todayStr

          return (
            <button
              key={cell.key}
              type="button"
              className={`calendar-cell ${cell.heatClass} ${isSelected ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}`}
              title={cell.tooltip}
              onClick={() => props.onSelectDate(cell.date!)}
            >
              <span className="calendar-day-number">{cell.dayNumber}</span>
              {cell.durationLabel ? (
                <span className="calendar-duration">{cell.durationLabel}</span>
              ) : null}
              {cell.topAppLabel ? (
                <span className="calendar-top-app">{cell.topAppLabel}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

type CalendarCell = {
  key: string
  date: string | null
  dayNumber: number | null
  durationLabel: string | null
  topAppLabel: string | null
  heatClass: string
  tooltip: string
}

function buildCalendarCells(month: string, days: DaySummary[]): CalendarCell[] {
  const [yearStr, monthStr] = month.split('-')
  const year = Number(yearStr)
  const monthNum = Number(monthStr)

  const firstDay = new Date(Date.UTC(year, monthNum - 1, 1))
  // Monday = 0, Sunday = 6
  const startWeekday = (firstDay.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()

  const dayMap = new Map(days.map((d) => [d.date, d]))
  const maxActive = Math.max(...days.map((d) => d.active_seconds), 0)

  const cells: CalendarCell[] = []

  // Leading empty cells
  for (let i = 0; i < startWeekday; i++) {
    cells.push({
      key: `empty-start-${i}`,
      date: null,
      dayNumber: null,
      durationLabel: null,
      topAppLabel: null,
      heatClass: '',
      tooltip: '',
    })
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${yearStr}-${monthStr}-${String(day).padStart(2, '0')}`
    const summary = dayMap.get(dateStr)
    const activeSeconds = summary?.active_seconds ?? 0

    const heatLevel = maxActive > 0 ? heatTier(activeSeconds, maxActive) : 0
    const topApp = summary?.top_app
    const topDomain = summary?.top_domain

    const tooltipLines = [dateStr]
    if (summary) {
      tooltipLines.push(`活跃: ${formatDuration(activeSeconds)}`)
      tooltipLines.push(`应用: ${formatDuration(summary.focus_seconds)}`)
      if (topApp) tooltipLines.push(`常用应用: ${topApp.label}`)
      if (topDomain) tooltipLines.push(`常用域名: ${topDomain.label}`)
    }

    cells.push({
      key: dateStr,
      date: dateStr,
      dayNumber: day,
      durationLabel: activeSeconds > 0 ? formatDuration(activeSeconds) : null,
      topAppLabel: topApp ? truncate(topApp.label, 10) : null,
      heatClass: HEAT_CLASSES[heatLevel],
      tooltip: tooltipLines.join('\n'),
    })
  }

  // Trailing empty cells to fill the last row
  const trailing = (7 - (cells.length % 7)) % 7
  for (let i = 0; i < trailing; i++) {
    cells.push({
      key: `empty-end-${i}`,
      date: null,
      dayNumber: null,
      durationLabel: null,
      topAppLabel: null,
      heatClass: '',
      tooltip: '',
    })
  }

  return cells
}

/** Maps active_seconds into 5 tiers (0-4) relative to the month's max. */
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
  let m = Number(monthStr) + delta
  while (m < 1) {
    year -= 1
    m += 12
  }
  while (m > 12) {
    year += 1
    m -= 12
  }
  return `${year}-${String(m).padStart(2, '0')}`
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(max - 1, 1))}…`
}
