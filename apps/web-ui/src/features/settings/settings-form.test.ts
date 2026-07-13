import { describe, expect, it } from 'vitest'
import type { AgentSettingsResponse } from '../../shared/api'
import {
  appendConfigListItem,
  formValuesToUpdatePayload,
  settingsFormKey,
  settingsToFormValues,
} from './settings-form'

const settings: AgentSettingsResponse = {
  autostart_enabled: true,
  tray_enabled: true,
  web_ui_url: 'http://127.0.0.1:4173',
  launch_command: 'timeline.exe',
  idle_threshold_secs: 120,
  poll_interval_millis: 1000,
  health_reminder_enabled: true,
  health_reminder_threshold_secs: 3000,
  health_reminder_work_start: '09:00',
  health_reminder_work_end: '18:00',
  health_reminder_quiet_start: '22:00',
  health_reminder_quiet_end: '08:00',
  record_window_titles: true,
  record_page_titles: false,
  ignored_apps: ['chrome.exe'],
  ignored_domains: ['example.com'],
  recent_apps: [{ key: 'chrome.exe', label: 'Google Chrome' }],
  recent_domains: [{ key: 'example.com', label: 'example.com' }],
  monitors: [],
  last_backup_at: null,
}

describe('settings form', () => {
  it('maps settings into editable form values', () => {
    const values = settingsToFormValues(settings)

    expect(values.ignoredAppsText).toBe('chrome.exe')
    expect(values.ignoredDomainsText).toBe('example.com')
    expect(values.healthReminderWorkHoursEnabled).toBe(true)
    expect(values.healthReminderQuietHoursEnabled).toBe(true)
    expect(settingsFormKey(settings)).toContain('120|1000|true')
  })

  it('clamps and parses payload values', () => {
    const payload = formValuesToUpdatePayload({
      idleThresholdSecs: 10,
      pollIntervalMillis: 80,
      healthReminderEnabled: false,
      healthReminderThresholdSecs: 200,
      healthReminderWorkHoursEnabled: false,
      healthReminderWorkStart: '09:00',
      healthReminderWorkEnd: '18:00',
      healthReminderQuietHoursEnabled: true,
      healthReminderQuietStart: '22:00',
      healthReminderQuietEnd: '08:00',
      recordWindowTitles: false,
      recordPageTitles: true,
      ignoredAppsText: 'foo.exe\nbar.exe',
      ignoredDomainsText: 'a.com, b.com',
    })

    expect(payload.idle_threshold_secs).toBe(15)
    expect(payload.poll_interval_millis).toBe(250)
    expect(payload.health_reminder_threshold_secs).toBe(300)
    expect(payload.health_reminder_work_start).toBe('')
    expect(payload.health_reminder_work_end).toBe('')
    expect(payload.health_reminder_quiet_start).toBe('22:00')
    expect(payload.health_reminder_quiet_end).toBe('08:00')
    expect(payload.ignored_apps).toEqual(['foo.exe', 'bar.exe'])
    expect(payload.ignored_domains).toEqual(['a.com', 'b.com'])
  })

  it('adds recent values without case-insensitive duplicates', () => {
    expect(appendConfigListItem('chrome.exe', 'CHROME.EXE')).toBe('chrome.exe')
    expect(appendConfigListItem('chrome.exe', 'code.exe')).toBe('chrome.exe\ncode.exe')
  })
})
