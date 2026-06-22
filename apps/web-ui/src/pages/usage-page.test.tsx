// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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

describe('UsagePage', () => {
  it('renders the usage trend card with week/month toggle (no intraday)', () => {
    render(
      <UsagePage
        loading={false}
        selectedDate="2026-06-18"
        appUsageMetric="visible_window"
        setAppUsageMetric={vi.fn()}
        appTrendView="week"
        setAppTrendView={vi.fn()}
        appTrend={null}
        appTrendError={null}
        isAppTrendRefreshing={false}
      />,
    )

    expect(screen.getByRole('heading', { name: '使用趋势' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '周' })).toHaveClass('is-active')
    expect(screen.queryByRole('button', { name: '日内' })).not.toBeInTheDocument()
    expect(screen.getByText(/占据所在屏幕至少 25%/)).toBeInTheDocument()
  })
})
