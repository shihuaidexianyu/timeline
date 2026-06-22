import { useEffect, useMemo } from 'react'
import {
  usePeriodSummaryQuery,
  useTimelineDayQuery,
} from '../shared/api'
import { buildDashboardModel } from '../lib/chart-model'
import { useSelectedDateState } from './use-selected-date-state'

/// Shared data layer used by all pages. Manages the "today" timeline query
/// (which bootstraps the selected date), the period summary, and the
/// date-selection state. Page-specific queries (calendar, app stats, trend,
/// settings) live in their respective pages to avoid fetching data that
/// isn't needed for the current page.
export function useSharedData() {
  const timelineQuery = useTimelineDayQuery(null)
  const timeline = timelineQuery.data ?? null
  const periodQuery = usePeriodSummaryQuery(timeline?.date ?? null)
  const agentToday = periodQuery.data?.date ?? null
  const agentTimezone = timeline?.timezone ?? null
  const dateState = useSelectedDateState({ agentToday, agentTimezone })

  // Selected-date queries. When the user picks a date different from today,
  // we fetch that date's timeline and period summary separately.
  const selectedTimelineQuery = useTimelineDayQuery(dateState.selectedDate, {
    enabled:
      dateState.selectedDate !== null &&
      dateState.selectedDate !== timeline?.date,
  })
  const selectedPeriodQuery = usePeriodSummaryQuery(dateState.selectedDate, {
    enabled:
      dateState.selectedDate !== null &&
      dateState.selectedDate !== (periodQuery.data?.date ?? timeline?.date),
  })

  const selectedTimeline = dateState.selectedDate
    ? selectedTimelineQuery.data ??
      (dateState.selectedDate === timeline?.date ? timeline : undefined)
    : timeline
  const selectedPeriodSummary = dateState.selectedDate
    ? selectedPeriodQuery.data ??
      (dateState.selectedDate === periodQuery.data?.date ? periodQuery.data : undefined)
    : periodQuery.data

  // Initialize the selected date once "today" is known.
  useEffect(() => {
    if (!timeline || dateState.selectedDate !== null) {
      return
    }
    if (!periodQuery.data && !periodQuery.isError) {
      return
    }
    dateState.initializeDate(timeline.date)
  }, [dateState, periodQuery.data, periodQuery.isError, timeline])

  const dashboard = useMemo(
    () => (selectedTimeline ? buildDashboardModel(selectedTimeline, false) : null),
    [selectedTimeline],
  )

  const lastTimelineDataUpdatedAt = Math.max(
    timelineQuery.dataUpdatedAt,
    selectedTimelineQuery.dataUpdatedAt,
  )

  const resolvedSelectedDate =
    dateState.selectedDate ?? selectedTimeline?.date ?? timeline?.date ?? '--'
  const resolvedTimezone =
    selectedTimeline?.timezone ?? timeline?.timezone ?? agentTimezone ?? '--'

  const hasDashboard = dashboard !== null
  const isInitialLoading =
    !hasDashboard &&
    (selectedTimelineQuery.isPending || timelineQuery.isPending)

  const isTimelineRefreshing =
    (timelineQuery.isFetching || selectedTimelineQuery.isFetching) && hasDashboard

  return {
    timelineQuery,
    selectedTimelineQuery,
    periodQuery,
    selectedPeriodQuery,
    selectedPeriodSummary,
    dashboard,
    dateState,
    resolvedSelectedDate,
    resolvedTimezone,
    hasDashboard,
    isInitialLoading,
    isTimelineRefreshing,
    lastTimelineDataUpdatedAt,
  }
}

export type SharedData = ReturnType<typeof useSharedData>
