import { describe, expect, it } from 'vitest'
import type { ChartSegment } from './chart-model'
import { buildDayUsageTrendModel } from './day-usage-trend-model'

function segment(partial: Partial<ChartSegment> & Pick<ChartSegment, 'id' | 'key' | 'label' | 'startSec' | 'endSec'>): ChartSegment {
  return {
    detail: partial.label,
    tone: 'visible',
    durationSec: partial.endSec - partial.startSec,
    color: partial.color ?? '#2E7D9B',
    ...partial,
  }
}

describe('day usage trend model', () => {
  it('aggregates app usage into ten-minute line points', () => {
    const model = buildDayUsageTrendModel({
      appSegments: [
        segment({
          id: 'codex',
          key: 'codex.exe',
          label: 'Codex',
          startSec: 10 * 60,
          endSec: 20 * 60,
          color: '#e76f51',
        }),
        segment({
          id: 'edge',
          key: 'msedge.exe',
          label: 'Microsoft Edge',
          startSec: 10 * 60 + 20,
          endSec: 20 * 60,
          color: '#2a9d8f',
        }),
      ],
    })

    expect(model.labels).toHaveLength(144)
    expect(model.labels.slice(0, 3)).toEqual(['00:00', '00:10', '00:20'])
    expect(model.series.map((series) => series.key)).toEqual(['codex.exe', 'msedge.exe'])
    expect(model.series[0].bucketSeconds[1]).toBe(600)
    expect(model.series[1].bucketSeconds[1]).toBe(580)
  })
})
