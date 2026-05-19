import { startTransition, useCallback, useState } from 'react'
import {
  coerceDateIntoMonth,
  defaultTimelineViewport,
  monthFromDate,
} from '../lib/dashboard-helpers'

export type TimelineViewport = {
  zoomHours: number
  viewStartHour: number
  viewStartSec: number
  viewEndSec: number
}

export function useSelectedDateState(args: {
  agentToday: string | null
  agentTimezone: string | null
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [calendarMonth, setCalendarMonth] = useState<string | null>(null)
  const [zoomHours, setZoomHours] = useState<number>(0.5)
  const [viewStartHour, setViewStartHour] = useState(0)

  const initializeDate = useCallback(
    (date: string) => {
      if (selectedDate !== null) {
        return
      }

      const nextWindow = defaultTimelineViewport(
        date,
        args.agentToday,
        args.agentTimezone,
      )
      setSelectedDate(date)
      setCalendarMonth(monthFromDate(date))
      setZoomHours(nextWindow.zoomHours)
      setViewStartHour(nextWindow.viewStartHour)
    },
    [args.agentTimezone, args.agentToday, selectedDate],
  )

  const selectDate = useCallback(
    (nextDate: string) => {
      const nextWindow = defaultTimelineViewport(
        nextDate,
        args.agentToday,
        args.agentTimezone,
      )

      startTransition(() => {
        setSelectedDate(nextDate)
        setCalendarMonth(monthFromDate(nextDate))
        setZoomHours(nextWindow.zoomHours)
        setViewStartHour(nextWindow.viewStartHour)
      })
    },
    [args.agentTimezone, args.agentToday],
  )

  const selectCalendarMonth = useCallback(
    (nextMonth: string) => {
      const baseDate = selectedDate ?? args.agentToday ?? `${nextMonth}-01`
      const nextDate = coerceDateIntoMonth(nextMonth, baseDate)
      const nextWindow = defaultTimelineViewport(
        nextDate,
        args.agentToday,
        args.agentTimezone,
      )

      startTransition(() => {
        setCalendarMonth(nextMonth)
        setSelectedDate(nextDate)
        setZoomHours(nextWindow.zoomHours)
        setViewStartHour(nextWindow.viewStartHour)
      })
    },
    [args.agentTimezone, args.agentToday, selectedDate],
  )

  const clampedViewStartHour = Math.max(0, Math.min(viewStartHour, 24 - zoomHours))
  const viewport: TimelineViewport = {
    zoomHours,
    viewStartHour: clampedViewStartHour,
    viewStartSec: clampedViewStartHour * 3600,
    viewEndSec: clampedViewStartHour * 3600 + zoomHours * 3600,
  }

  return {
    selectedDate,
    calendarMonth,
    viewport,
    initializeDate,
    selectDate,
    selectCalendarMonth,
    setZoomHours,
    setViewStartHour,
  }
}
