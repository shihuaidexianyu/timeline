// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TimelineChart } from './timeline-chart'
import type { ChartSegment } from '../lib/chart-model'

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver

function segment(id: string, color: string): ChartSegment {
  return {
    id,
    key: id,
    label: id,
    detail: id,
    tone: 'focus',
    startSec: id === 'code' ? 0 : 1800,
    endSec: id === 'code' ? 1200 : 3000,
    durationSec: 1200,
    color,
    isBrowser: false,
  }
}

describe('TimelineChart', () => {
  it('uses each segment color as the bar background', () => {
    const { container } = render(
      <TimelineChart
        rows={[
          {
            id: 'focus',
            label: '应用',
            segments: [segment('code', '#ff6b6b'), segment('weixin', '#45b7d1')],
            splitByKey: false,
          },
        ]}
        viewStartSec={0}
        viewEndSec={3600}
      />,
    )

    const bars = Array.from(container.querySelectorAll<HTMLElement>('.timeline-bar'))

    expect(bars.map((bar) => bar.style.background)).toEqual([
      'rgb(255, 107, 107)',
      'rgb(69, 183, 209)',
    ])
  })
})
