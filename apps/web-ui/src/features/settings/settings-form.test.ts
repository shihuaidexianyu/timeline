import { describe, expect, it } from 'vitest'
import type { AgentSettingsResponse } from '../../shared/api'
import {
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
  record_window_titles: true,
  record_page_titles: false,
  ignored_apps: ['chrome.exe'],
  ignored_domains: ['example.com'],
  domain_groups: [],
  monitors: [],
}

describe('settings form', () => {
  it('maps settings into editable form values', () => {
    const values = settingsToFormValues(settings)

    expect(values.ignoredAppsText).toBe('chrome.exe')
    expect(values.ignoredDomainsText).toBe('example.com')
    expect(values.domainGroupsText).toBe('')
    expect(settingsFormKey(settings)).toContain('120|1000|true')
  })

  it('clamps and parses payload values', () => {
    const payload = formValuesToUpdatePayload({
      idleThresholdSecs: 10,
      pollIntervalMillis: 80,
      healthReminderEnabled: false,
      healthReminderThresholdSecs: 200,
      recordWindowTitles: false,
      recordPageTitles: true,
      ignoredAppsText: 'foo.exe\nbar.exe',
      ignoredDomainsText: 'a.com, b.com',
      domainGroupsText: 'github = [github.com, gist.github.com]',
    })

    expect(payload.idle_threshold_secs).toBe(15)
    expect(payload.poll_interval_millis).toBe(250)
    expect(payload.health_reminder_threshold_secs).toBe(300)
    expect(payload.ignored_apps).toEqual(['foo.exe', 'bar.exe'])
    expect(payload.ignored_domains).toEqual(['a.com', 'b.com'])
    expect(payload.domain_groups).toEqual(['github = [github.com, gist.github.com]'])
  })
})
