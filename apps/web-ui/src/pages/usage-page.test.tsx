// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DashboardModel } from '../lib/chart-model'
import { UsagePage } from './usage-page'

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

describe('UsagePage', () => {
  it('renders a lazy boundary for the intraday line chart inside the usage trend card', () => {
    const { container } = render(
      <UsagePage
        dashboard={dashboard}
        loading={false}
        selectedDate="2026-06-18"
        appUsageMetric="visible_window"
        setAppUsageMetric={vi.fn()}
        appTrendView="day"
        setAppTrendView={vi.fn()}
        appTrend={null}
        appTrendError={null}
        isTimelineRefreshing={false}
        isAppTrendRefreshing={false}
      />,
    )

    expect(screen.getByRole('heading', { name: '使用趋势' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '日内' })).toHaveClass('is-active')
    expect(screen.getByRole('status', { name: '图表加载中' })).toBeInTheDocument()
    expect(screen.getByText(/占据所在屏幕至少 25%/)).toBeInTheDocument()
    expect(container.querySelectorAll('.minute-grid-cell')).toHaveLength(0)
  })
})
