import { describe, expect, it } from 'vitest'
import type { ChartSegment } from './chart-model'
import { buildPrimaryBrowserDomainMap } from './dashboard-helpers'

function segment(
  id: string,
  label: string,
  startSec: number,
  endSec: number,
  isBrowser = false,
): ChartSegment {
  return {
    id,
    key: label,
    label,
    detail: '',
    tone: isBrowser ? 'focus' : 'browser',
    startSec,
    endSec,
    durationSec: endSec - startSec,
    color: '#000',
    isBrowser,
  }
}

describe('buildPrimaryBrowserDomainMap', () => {
  it('sweeps unsorted intervals and accumulates the dominant overlapping domain', () => {
    const focus = [
      segment('editor', 'Editor', 100, 200, false),
      segment('browser-2', 'Browser', 60, 100, true),
      segment('browser-1', 'Browser', 0, 60, true),
    ]
    const browser = [
      segment('b3', 'docs.example', 80, 100),
      segment('b1', 'mail.example', 0, 20),
      segment('b2', 'docs.example', 20, 55),
      segment('b4', 'mail.example', 60, 82),
    ]

    const result = buildPrimaryBrowserDomainMap(focus, browser)

    expect(result.get('browser-1')).toBe('docs.example')
    expect(result.get('browser-2')).toBe('mail.example')
    expect(result.has('editor')).toBe(false)
  })
})
