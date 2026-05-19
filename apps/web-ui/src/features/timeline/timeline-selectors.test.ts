import { describe, expect, it } from 'vitest'
import {
  filterTimelineFocusSegments,
  normalizeTimelineSearchQuery,
  type TimelineSegmentKind,
} from './timeline-selectors'
import type { ChartSegment } from '../../lib/chart-model'

const focusSegment: ChartSegment = {
  id: 'focus-1',
  key: 'Code.exe',
  label: 'Visual Studio Code',
  detail: 'timeline-page.tsx',
  tone: 'focus',
  startSec: 0,
  endSec: 3600,
  durationSec: 3600,
  color: '#45B7D1',
  isBrowser: false,
}

const browserSegment: ChartSegment = {
  id: 'focus-2',
  key: 'msedge.exe',
  label: 'Microsoft Edge',
  detail: 'treehole.pku.edu.cn',
  tone: 'focus',
  startSec: 3600,
  endSec: 5400,
  durationSec: 1800,
  color: '#FF6B6B',
  isBrowser: true,
}

describe('timeline selectors', () => {
  it('normalizes search text', () => {
    expect(normalizeTimelineSearchQuery('  TreeHole.PKU.EDU.CN  ')).toBe(
      'treehole.pku.edu.cn',
    )
  })

  it.each<TimelineSegmentKind>(['all', 'app', 'browser'])(
    'filters by kind %s and search',
    (kind) => {
      const segments = [focusSegment, browserSegment]
      const filtered = filterTimelineFocusSegments(
        segments,
        new Map([[browserSegment.id, 'treehole.pku.edu.cn']]),
        kind === 'browser' ? 'treehole' : 'visual',
        kind,
      )

      if (kind === 'all') {
        expect(filtered).toHaveLength(1)
        expect(filtered[0]?.id).toBe('focus-1')
      }

      if (kind === 'app') {
        expect(filtered).toHaveLength(1)
        expect(filtered[0]?.id).toBe('focus-1')
      }

      if (kind === 'browser') {
        expect(filtered).toHaveLength(1)
        expect(filtered[0]?.id).toBe('focus-2')
      }
    },
  )
})
