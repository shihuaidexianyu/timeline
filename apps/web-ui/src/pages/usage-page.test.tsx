// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SharedData } from '../app/use-shared-data'
import { UsagePage } from './usage-page'

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 800,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    value: 400,
  })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400 }),
  })
})

function makeShared(overrides: Partial<SharedData> = {}): SharedData {
  return {
    timelineQuery: { data: { date: '2026-06-18', timezone: '+00:00' }, isPending: false, isFetching: false, error: null, dataUpdatedAt: 0, refetch: vi.fn() } as unknown as SharedData['timelineQuery'],
    selectedTimelineQuery: { data: null, isPending: false, isFetching: false, error: null, dataUpdatedAt: 0, refetch: vi.fn() } as unknown as SharedData['selectedTimelineQuery'],
    periodQuery: { data: null, isPending: false, isFetching: false, error: null } as unknown as SharedData['periodQuery'],
    selectedPeriodQuery: { data: null, isPending: false, isFetching: false, error: null } as unknown as SharedData['selectedPeriodQuery'],
    selectedPeriodSummary: null,
    dashboard: null,
    dateState: {
      selectedDate: '2026-06-18',
      calendarMonth: '2026-06',
      viewport: { zoomHours: 0.5, viewStartHour: 0, viewStartSec: 0, viewEndSec: 1800 },
      initializeDate: vi.fn(),
      selectDate: vi.fn(),
      selectCalendarMonth: vi.fn(),
      setZoomHours: vi.fn(),
      setViewStartHour: vi.fn(),
    },
    resolvedSelectedDate: '2026-06-18',
    resolvedTimezone: '+00:00',
    hasDashboard: true,
    isInitialLoading: false,
    isTimelineRefreshing: false,
    lastTimelineDataUpdatedAt: 0,
    ...overrides,
  }
}

describe('UsagePage', () => {
  it('renders the usage trend card with week/month toggle (no intraday)', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <UsagePage
          shared={makeShared()}
          appUsageMetric="focus"
          setAppUsageMetric={vi.fn()}
        />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('heading', { name: '使用趋势' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '周' })).toHaveClass('is-active')
    expect(screen.queryByRole('button', { name: '日内' })).not.toBeInTheDocument()
    expect(screen.getByText(/只统计当前获得焦点的窗口/)).toBeInTheDocument()
  })
})
