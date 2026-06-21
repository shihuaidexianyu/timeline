import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSettingsResponse } from '../shared/api'
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

describe('SettingsPage monitors', () => {
  it('renders a compact Chinese status overview instead of raw status badges', () => {
    render(
      <SettingsPage
        agentSettings={settings}
        loading={false}
        error={null}
        settingsError={null}
        settingsNotice={null}
        lastUpdatedAt="14:50:21"
        selectedDate="2026-06-18"
        timezone="Asia/Shanghai"
        savingAutostart={false}
        savingConfig={false}
        isSettingsRefreshing={false}
        theme="system"
        onChangeTheme={vi.fn()}
        onToggleAutostart={vi.fn()}
        onUpdateConfig={vi.fn()}
      />,
    )

    expect(screen.getByText('2 个采集模块正常')).toBeInTheDocument()
    expect(screen.getAllByText('正常')).toHaveLength(2)
    expect(screen.queryByText('online')).not.toBeInTheDocument()
  })
})
