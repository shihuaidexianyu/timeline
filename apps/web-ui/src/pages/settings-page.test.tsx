import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { apiQueryKeys, type AgentSettingsResponse } from '../shared/api'
import type { SharedData } from '../app/use-shared-data'
import { SettingsPage } from './settings-page'

const settings: AgentSettingsResponse = {
  autostart_enabled: true,
  tray_enabled: true,
  web_ui_url: 'http://127.0.0.1:46215/#/stats',
  launch_command: 'timeline.exe',
  idle_threshold_secs: 300,
  poll_interval_millis: 1000,
  health_reminder_enabled: true,
  health_reminder_threshold_secs: 3000,
  record_window_titles: true,
  record_page_titles: true,
  ignored_apps: [],
  ignored_domains: [],
  domain_groups: [],
  monitors: [
    {
      key: 'focus_tracker',
      label: '前台窗口监视器',
      status: 'online',
      detail: '轮询前台应用和窗口标题',
      last_seen: '2026-06-18T06:50:21.000Z',
    },
    {
      key: 'visible_window_tracker',
      label: '可见窗口监视器',
      status: 'online',
      detail: '枚举当前桌面实际露出的窗口',
      last_seen: '2026-06-18T06:50:21.000Z',
    },
  ],
}

function makeShared(): SharedData {
  return {
    timelineQuery: { data: null, isPending: false, isFetching: false, error: null, dataUpdatedAt: 0, refetch: vi.fn() } as unknown as SharedData['timelineQuery'],
    selectedTimelineQuery: { data: null, isPending: false, isFetching: false, error: null, dataUpdatedAt: 0, refetch: vi.fn() } as unknown as SharedData['selectedTimelineQuery'],
    periodQuery: { data: null, isPending: false, isFetching: false, error: null } as unknown as SharedData['periodQuery'],
    selectedPeriodQuery: { data: null, isPending: false, isFetching: false, error: null } as unknown as SharedData['selectedPeriodQuery'],
    selectedPeriodSummary: null,
    dashboard: null,
    dateState: {
      selectedDate: '2026-06-18',
      calendarMonth: '2026-06',
      viewport: { zoomHours: 0.5, viewStartHour: 0, viewStartSec: 0, viewEndSec: 1800 },
      initializeDate: vi.fn(),
      selectDate: vi.fn(),
      selectCalendarMonth: vi.fn(),
      setZoomHours: vi.fn(),
      setViewStartHour: vi.fn(),
    },
    resolvedSelectedDate: '2026-06-18',
    resolvedTimezone: 'Asia/Shanghai',
    hasDashboard: true,
    isInitialLoading: false,
    isTimelineRefreshing: false,
    lastTimelineDataUpdatedAt: Date.now(),
  }
}

describe('SettingsPage monitors', () => {
  it('renders a compact Chinese status overview instead of raw status badges', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    queryClient.setQueryData(apiQueryKeys.agentSettings(), settings)

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage
          shared={makeShared()}
          theme="system"
          onChangeTheme={vi.fn()}
        />
      </QueryClientProvider>,
    )

    expect(screen.getByText('2 个采集模块正常')).toBeInTheDocument()
    expect(screen.getAllByText('正常')).toHaveLength(2)
    expect(screen.queryByText('online')).not.toBeInTheDocument()
  })
})
