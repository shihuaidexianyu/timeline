import { createServer } from 'node:http'

const activeRollupStatus = {
  status: 'ready', completed_days: 1, total_days: 1,
  next_date: null, last_error: null, updated_at: '2026-07-13T03:00:00Z',
}
const timeline = {
  date: '2026-07-13', timezone: '+08:00',
  focus_segments: [
    { id: 1, started_at: '2026-07-13T01:00:00Z', ended_at: '2026-07-13T02:00:00Z', app: { process_name: 'code.exe', display_name: 'Visual Studio Code', exe_path: null, window_title: 'timeline', is_browser: false } },
    { id: 2, started_at: '2026-07-13T02:00:00Z', ended_at: '2026-07-13T02:30:00Z', app: { process_name: 'msedge.exe', display_name: 'Microsoft Edge', exe_path: null, window_title: 'Timeline', is_browser: true } },
  ],
  browser_segments: [
    { id: 1, domain: 'example.com', page_title: null, browser_window_id: 1, tab_id: 2, started_at: '2026-07-13T02:00:00Z', ended_at: '2026-07-13T02:30:00Z' },
  ],
  presence_segments: [
    { id: 1, state: 'active', started_at: '2026-07-13T01:00:00Z', ended_at: '2026-07-13T02:15:00Z' },
    { id: 2, state: 'idle', started_at: '2026-07-13T02:15:00Z', ended_at: '2026-07-13T02:30:00Z' },
  ],
}
const period = (foreground, active) => ({ focus_seconds: foreground, active_seconds: active, foreground_seconds: foreground, active_foreground_seconds: active })
const responses = {
  '/health': { service: 'timeline', status: 'ok', started_at: '2026-07-13T00:00:00Z', database_path: 'mock.sqlite', listen_addr: '127.0.0.1:46216', timezone: '+08:00', version: '1.1.0', schema_version: 7, rollup_algorithm_version: '1' },
  '/api/timeline/day': timeline,
  '/api/stats/summary': { date: timeline.date, timezone: timeline.timezone, today: period(5400, 4500), week: period(5400, 4500), month: period(5400, 4500), active_rollup_status: activeRollupStatus },
  '/api/calendar/month': { month: '2026-07', timezone: '+08:00', days: [{ date: timeline.date, focus_seconds: 5400, active_seconds: 4500, browser_seconds: 1800, switch_count: 1, active_app_seconds: 4500, active_browser_seconds: 900, active_switch_count: 1, top_app: { key: 'code.exe', label: 'Visual Studio Code', seconds: 3600 }, top_domain: { key: 'example.com', label: 'example.com', seconds: 1800 } }], active_rollup_status: activeRollupStatus },
  '/api/stats/apps/trend': { period: 'week', start_date: '2026-07-13', end_date: '2026-07-19', timezone: '+08:00', days: ['2026-07-13'], series: [{ key: 'code.exe', label: 'Visual Studio Code', total_seconds: 3600, daily_seconds: [3600], active_total_seconds: 3600, active_daily_seconds: [3600] }], active_rollup_status: activeRollupStatus },
  '/api/settings': { autostart_enabled: true, tray_enabled: true, web_ui_url: 'http://127.0.0.1:4173', launch_command: 'timeline.exe', idle_threshold_secs: 300, poll_interval_millis: 1000, health_reminder_enabled: true, health_reminder_threshold_secs: 3000, health_reminder_work_start: null, health_reminder_work_end: null, health_reminder_quiet_start: null, health_reminder_quiet_end: null, record_window_titles: true, record_page_titles: false, ignored_apps: [], ignored_domains: [], recent_apps: [{ key: 'code.exe', label: 'Visual Studio Code' }], recent_domains: [{ key: 'example.com', label: 'example.com' }], monitors: [{ key: 'focus', label: '前台窗口监视器', status: 'online', detail: '正常', last_seen: '2026-07-13T03:00:00Z', last_error: null, consecutive_failures: 0, restart_count: 0 }], tracking_paused: false, paused_since: null, pause_until: null, retention_days: null, database_size_bytes: 1048576, earliest_recorded_date: '2026-07-13', last_backup_at: null, version: '1.1.0', schema_version: 7, active_rollup_status: activeRollupStatus },
}

createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  const data = responses[path]
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4173')
  response.setHeader('Access-Control-Allow-Headers', 'content-type')
  response.setHeader('Content-Type', 'application/json')
  if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return }
  if (!data) { response.statusCode = 404; response.end(JSON.stringify({ ok: false, data: null, error: { code: 'not_found', message: path } })); return }
  response.end(JSON.stringify({ ok: true, data, error: null }))
}).listen(46216, '127.0.0.1')
