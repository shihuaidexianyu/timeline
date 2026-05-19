import type { DonutSlice } from '../../lib/chart-model'
import type { WeekBarDatum } from '../../lib/dashboard-helpers'

export function createWeeklySkeletonBars(): WeekBarDatum[] {
  return [
    { date: 'skeleton-1', dayLabel: '一', activeSeconds: 3.6 * 3600, focusSeconds: 4.8 * 3600, isSelected: false },
    { date: 'skeleton-2', dayLabel: '二', activeSeconds: 5.4 * 3600, focusSeconds: 6.8 * 3600, isSelected: false },
    { date: 'skeleton-3', dayLabel: '三', activeSeconds: 3.2 * 3600, focusSeconds: 3.4 * 3600, isSelected: false },
    { date: 'skeleton-4', dayLabel: '四', activeSeconds: 5.2 * 3600, focusSeconds: 5.2 * 3600, isSelected: false },
    { date: 'skeleton-5', dayLabel: '五', activeSeconds: 2.0 * 3600, focusSeconds: 2.6 * 3600, isSelected: false },
    { date: 'skeleton-6', dayLabel: '六', activeSeconds: 0, focusSeconds: 0, isSelected: false },
    { date: 'skeleton-7', dayLabel: '日', activeSeconds: 0, focusSeconds: 0, isSelected: false },
  ]
}

export function sumSlices(slices: DonutSlice[]) {
  return slices.reduce((sum, slice) => sum + slice.value, 0)
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

export function niceWeeklyAxisMax(seconds: number) {
  const hours = seconds / 3600

  if (hours <= 2) {
    return 2 * 3600
  }
  if (hours <= 4) {
    return 4 * 3600
  }
  if (hours <= 6) {
    return 6 * 3600
  }
  if (hours <= 8) {
    return 8 * 3600
  }

  return Math.ceil(hours / 4) * 4 * 3600
}

export function formatWeeklyAxisTick(seconds: number) {
  return `${Math.round(seconds / 3600)} 小时`
}
