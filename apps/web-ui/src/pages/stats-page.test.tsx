// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DashboardModel } from '../lib/chart-model'
import type { SharedData } from '../app/use-shared-data'
import { StatsPage } from './stats-page'

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

const dashboard: DashboardModel = {
  focusSegments: [
    {
      id: 'focus-codex',
      key: 'codex.exe',
      label: 'Codex',
      detail: 'Codex',
      tone: 'focus',
      startSec: 0,
      endSec: 600,
      durationSec: 600,
      color: '#2E7D9B',
      isBrowser: false,
    },
  ],
  visibleWindowSegments: [
    {
      id: 'visible-codex',
      key: 'codex.exe',
      label: 'Codex',
      detail: 'Codex',
      tone: 'visible',
      startSec: 0,
      endSec: 600,
      durationSec: 600,
      color: '#2E7D9B',
      isBrowser: false,
    },
  ],
  browserSegments: [],
  presenceSegments: [
    {
      id: 'presence-active',
      key: 'active',
      label: '活跃',
      detail: 'active',
      tone: 'presence',
      startSec: 0,
      endSec: 600,
      durationSec: 600,
      color: '#3fb68a',
    },
  ],
  appSlices: [],
  domainSlices: [],
  presenceSlices: [],
  summary: {
    focusSeconds: 600,
    activeSeconds: 600,
    longestFocusSeconds: 600,
    switchCount: 0,
  },
  meta: {
    focusCount: 1,
    browserCount: 0,
    presenceCount: 1,
  },
}

function makeShared(overrides: Partial<SharedData> = {}): SharedData {
  return {
    timelineQuery: { data: null, isPending: false, isFetching: false, error: null, dataUpdatedAt: 0, refetch: vi.fn() } as unknown as SharedData['timelineQuery'],
    selectedTimelineQuery: { data: null, isPending: false, isFetching: false, error: null, dataUpdatedAt: 0, refetch: vi.fn() } as unknown as SharedData['selectedTimelineQuery'],
    periodQuery: { data: null, isPending: false, isFetching: false, error: null } as unknown as SharedData['periodQuery'],
    selectedPeriodQuery: { data: null, isPending: false, isFetching: false, error: null } as unknown as SharedData['selectedPeriodQuery'],
    selectedPeriodSummary: null,
    dashboard,
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

describe('StatsPage', () => {
  it('renders the weekly rhythm, focus balance and lazy distribution chart boundaries', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <StatsPage
          shared={makeShared()}
          appUsageMetric="focus"
          appFilter={null}
          domainFilter={null}
          setAppFilter={vi.fn()}
          setDomainFilter={vi.fn()}
          onSelectDate={vi.fn()}
          onCalendarMonthChange={vi.fn()}
        />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('heading', { name: '本周节奏' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '状态分布' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '应用分布' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '域名分布' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '使用热度' })).toBeInTheDocument()
    expect(screen.getAllByRole('status', { name: '图表加载中' }).length).toBeGreaterThan(0)
  })
})
