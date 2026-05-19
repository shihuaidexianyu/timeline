import { describe, expect, it } from 'vitest'
import {
  createWeeklySkeletonBars,
  formatPercent,
  formatWeeklyAxisTick,
  niceWeeklyAxisMax,
  sumSlices,
} from './stats-selectors'

describe('stats selectors', () => {
  it('builds stable weekly skeleton bars', () => {
    const bars = createWeeklySkeletonBars()
    expect(bars).toHaveLength(7)
    expect(bars.every((bar) => bar.dayLabel.length > 0)).toBe(true)
  })

  it('formats axis and sums slices', () => {
    expect(niceWeeklyAxisMax(3 * 3600)).toBe(4 * 3600)
    expect(formatWeeklyAxisTick(5 * 3600)).toBe('5 小时')
    expect(formatPercent(0.42)).toBe('42%')
    expect(sumSlices([{ value: 2 } as never, { value: 3 } as never])).toBe(5)
  })
})
