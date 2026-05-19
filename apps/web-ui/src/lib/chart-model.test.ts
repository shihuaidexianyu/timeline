import { describe, expect, it } from 'vitest'
import type { TimelineDayResponse } from '../shared/api'
import { buildDashboardModel } from './chart-model'
import { buildWeekSeries, defaultTimelineViewport } from './dashboard-helpers'

describe('chart model', () => {
  it('clips to active intervals when active-only is enabled', () => {
    const timeline: TimelineDayResponse = {
      date: '2026-05-19',
      timezone: '+00:00',
      focus_segments: [
        {
          id: 1,
          started_at: '2026-05-19T00:00:00Z',
          ended_at: '2026-05-19T01:00:00Z',
          app: {
            process_name: 'code.exe',
            display_name: 'Visual Studio Code',
            exe_path: null,
            window_title: 'timeline',
            is_browser: false,
          },
        },
      ],
      browser_segments: [],
      presence_segments: [
        {
          id: 1,
          state: 'active',
          started_at: '2026-05-19T00:15:00Z',
          ended_at: '2026-05-19T00:45:00Z',
        },
      ],
    }

    const dashboard = buildDashboardModel(timeline, true)
    expect(dashboard.focusSegments).toHaveLength(1)
    expect(dashboard.focusSegments[0]?.startSec).toBe(15 * 60)
    expect(dashboard.focusSegments[0]?.endSec).toBe(45 * 60)
  })

  it('converts UTC timestamps into local day seconds', () => {
    const dashboard = buildDashboardModel(
      {
        date: '2026-05-19',
        timezone: '+08:00',
        focus_segments: [
          {
            id: 1,
            started_at: '2026-05-18T16:00:00Z',
            ended_at: '2026-05-18T17:00:00Z',
            app: {
              process_name: 'code.exe',
              display_name: 'Code',
              exe_path: null,
              window_title: null,
              is_browser: false,
            },
          },
        ],
        browser_segments: [],
        presence_segments: [],
      },
      false,
    )

    expect(dashboard.focusSegments[0]?.startSec).toBe(0)
    expect(dashboard.focusSegments[0]?.endSec).toBe(3600)
  })

  it('builds an empty week series for invalid dates', () => {
    expect(buildWeekSeries([], 'not-a-date')).toEqual([])
  })

  it('uses a compact default viewport for today', () => {
    expect(defaultTimelineViewport('2026-05-19', '2026-05-19', '+08:00')).toMatchObject({
      zoomHours: 0.5,
    })
  })
})
