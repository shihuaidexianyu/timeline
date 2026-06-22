import { useMemo, useState } from 'react'
import { AppShell } from './AppShell'
import { useHashQueryParam, useHashRoute } from './page-route'
import { useSharedData } from './use-shared-data'
import { SettingsPage } from '../pages/settings-page'
import { StatsPage } from '../pages/stats-page'
import { UsagePage } from '../pages/usage-page'
import type { UsageMetric } from '../shared/api'
import type { DashboardFilter } from '../lib/chart-model'
import { useTheme } from '../hooks/use-theme'

export function AppController() {
  const { theme, setTheme } = useTheme()
  const [page, setPage] = useHashRoute()
  const [appFilter, setAppFilter] = useState<DashboardFilter>(null)
  const [domainFilter, setDomainFilter] = useState<DashboardFilter>(null)
  const [urlMetric, setUrlMetric] = useHashQueryParam('metric')
  const appUsageMetric: UsageMetric =
    urlMetric === 'focus' || urlMetric === 'visible_window' ? urlMetric : 'visible_window'
  const setAppUsageMetric = (value: UsageMetric) => setUrlMetric(value)

  const shared = useSharedData()

  const lastUpdatedAt = useMemo(
    () =>
      shared.lastTimelineDataUpdatedAt > 0
        ? new Date(shared.lastTimelineDataUpdatedAt).toLocaleTimeString()
        : null,
    [shared.lastTimelineDataUpdatedAt],
  )

  const serviceError = firstErrorMessage([
    shared.timelineQuery.error,
    shared.selectedTimelineQuery.error,
    shared.periodQuery.error,
    shared.selectedPeriodQuery.error,
  ])

  const hasDashboard = shared.hasDashboard
  const shouldRenderPage = hasDashboard || (shared.isInitialLoading && !serviceError)

  function selectDate(nextDate: string) {
    shared.dateState.selectDate(nextDate)
    setAppFilter(null)
    setDomainFilter(null)
  }

  function selectCalendarMonth(nextMonth: string) {
    shared.dateState.selectCalendarMonth(nextMonth)
    setDomainFilter(null)
  }

  return (
    <AppShell
      page={page}
      selectedDate={shared.resolvedSelectedDate}
      timezone={shared.resolvedTimezone}
      serviceError={serviceError}
      lastUpdatedAt={lastUpdatedAt}
      onPageChange={setPage}
    >
      {serviceError && !hasDashboard && !shouldRenderPage ? (
        <ErrorState error={serviceError} />
      ) : null}
      {serviceError && hasDashboard ? <InlineErrorState error={serviceError} /> : null}

      {shouldRenderPage ? (
        <>
          {page === 'stats' ? (
            <StatsPage
              shared={shared}
              appUsageMetric={appUsageMetric}
              appFilter={appFilter}
              domainFilter={domainFilter}
              setAppFilter={setAppFilter}
              setDomainFilter={setDomainFilter}
              onSelectDate={selectDate}
              onCalendarMonthChange={selectCalendarMonth}
            />
          ) : null}

          {page === 'usage' ? (
            <UsagePage
              shared={shared}
              appUsageMetric={appUsageMetric}
              setAppUsageMetric={setAppUsageMetric}
            />
          ) : null}

          {page === 'settings' ? (
            <SettingsPage
              shared={shared}
              theme={theme}
              onChangeTheme={setTheme}
            />
          ) : null}
        </>
      ) : null}
    </AppShell>
  )
}

function ErrorState(props: { error: string }) {
  return <div className="state-card error-card">{props.error}</div>
}

function InlineErrorState(props: { error: string }) {
  return <div className="inline-error-banner">{props.error}</div>
}

function firstErrorMessage(errors: unknown[]) {
  for (const error of errors) {
    const message = errorToNullableMessage(error)
    if (message) {
      return message
    }
  }

  return null
}

function errorToNullableMessage(error: unknown) {
  return error ? errorToMessage(error, '本地服务响应异常') : null
}

function errorToMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
