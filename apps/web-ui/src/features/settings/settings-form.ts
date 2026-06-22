import type { AgentSettingsResponse, UpdateAgentConfigRequest } from '../../shared/api'
import { clampNumber, parseConfigList } from '../../lib/dashboard-helpers'

/// Like parseConfigList but only splits on newlines (not commas), since
/// domain group entries contain commas inside `[...]` brackets.
function parseLineSeparatedList(value: string): string[] {
  const unique = new Set<string>()
  value
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .forEach((item) => {
      unique.add(item)
    })
  return Array.from(unique)
}

export type SettingsFormValues = {
  idleThresholdSecs: number
  pollIntervalMillis: number
  healthReminderEnabled: boolean
  healthReminderThresholdSecs: number
  recordWindowTitles: boolean
  recordPageTitles: boolean
  ignoredAppsText: string
  ignoredDomainsText: string
  domainGroupsText: string
}

export function settingsToFormValues(settings: AgentSettingsResponse): SettingsFormValues {
  return {
    idleThresholdSecs: Number.isFinite(settings.idle_threshold_secs)
      ? settings.idle_threshold_secs
      : 300,
    pollIntervalMillis: Number.isFinite(settings.poll_interval_millis)
      ? settings.poll_interval_millis
      : 1000,
    healthReminderEnabled: Boolean(settings.health_reminder_enabled),
    healthReminderThresholdSecs: Number.isFinite(
      settings.health_reminder_threshold_secs,
    )
      ? settings.health_reminder_threshold_secs
      : 3000,
    recordWindowTitles: Boolean(settings.record_window_titles),
    recordPageTitles: Boolean(settings.record_page_titles),
    ignoredAppsText: Array.isArray(settings.ignored_apps)
      ? settings.ignored_apps.join('\n')
      : '',
    ignoredDomainsText: Array.isArray(settings.ignored_domains)
      ? settings.ignored_domains.join('\n')
      : '',
    domainGroupsText: Array.isArray(settings.domain_groups)
      ? settings.domain_groups.join('\n')
      : '',
  }
}

export function formValuesToUpdatePayload(
  values: SettingsFormValues,
): UpdateAgentConfigRequest {
  return {
    idle_threshold_secs: clampNumber(Math.round(values.idleThresholdSecs), 15, 1800),
    poll_interval_millis: clampNumber(Math.round(values.pollIntervalMillis), 250, 5000),
    health_reminder_enabled: values.healthReminderEnabled,
    health_reminder_threshold_secs: clampNumber(
      Math.round(values.healthReminderThresholdSecs),
      300,
      21600,
    ),
    record_window_titles: values.recordWindowTitles,
    record_page_titles: values.recordPageTitles,
    ignored_apps: parseConfigList(values.ignoredAppsText),
    ignored_domains: parseConfigList(values.ignoredDomainsText),
    domain_groups: parseLineSeparatedList(values.domainGroupsText),
  }
}

export function settingsFormKey(settings: AgentSettingsResponse) {
  return [
    settings.idle_threshold_secs,
    settings.poll_interval_millis,
    settings.health_reminder_enabled,
    settings.health_reminder_threshold_secs,
    settings.record_window_titles,
    settings.record_page_titles,
    settings.ignored_apps.join(','),
    settings.ignored_domains.join(','),
    settings.domain_groups.join(','),
  ].join('|')
}
