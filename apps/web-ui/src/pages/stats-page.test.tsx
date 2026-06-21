// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DashboardModel } from '../lib/chart-model'
import { StatsPage } from './stats-page'

beforeAll(() => {
  // Provide dimensions for ECharts in jsdom so it does not warn about zero-size containers.
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

describe('StatsPage', () => {
  it('renders the weekly rhythm, focus balance and lazy distribution chart boundaries', () => {
    render(
      <StatsPage
        dashboard={dashboard}
        loading={false}
        appFilter={null}
        domainFilter={null}
        setAppFilter={vi.fn()}
        setDomainFilter={vi.fn()}
        periodSummary={null}
        appUsageMetric="visible_window"
        appStats={[]}
        appStatsTotalSeconds={0}
        calendarDays={[]}
        calendarMonth="2026-06"
        selectedDate="2026-06-18"
        agentToday="2026-06-18"
        calendarError={null}
        weekBars={[]}
        isTimelineRefreshing={false}
        isPeriodRefreshing={false}
        isAppStatsRefreshing={false}
        isCalendarRefreshing={false}
        appStatsError={null}
        onCalendarMonthChange={vi.fn()}
        onSelectDate={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: '本周节奏' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '状态分布' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '可见窗口分布' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '域名分布' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '使用热度' })).toBeInTheDocument()
    expect(screen.getAllByRole('status', { name: '图表加载中' }).length).toBeGreaterThan(0)
  })
})
