import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await mockApi(page)
})

test('stats page renders without invalid text', async ({ page }) => {
  await page.goto('/#/stats')

  await expect(page.getByRole('heading', { name: '统计概览' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '应用趋势' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/NaN|undefined/)
})

test('timeline search matches browser domains', async ({ page }) => {
  await page.goto('/#/timeline')

  await expect(page.getByPlaceholder('应用、标题、域名')).toBeVisible()
  await page.getByPlaceholder('应用、标题、域名').fill('treehole')
  await expect(page.getByText('treehole.pku.edu.cn').first()).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/NaN|undefined/)
})

test('dark theme is applied from stored preference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('timeline-theme', 'dark')
  })
  await page.goto('/#/timeline')

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('first-run privacy notice explains fields and opens settings', async ({ page }) => {
  await page.goto('/#/stats')

  await expect(page.getByRole('heading', { name: '先确认本地记录范围' })).toBeVisible()
  await expect(page.getByText('不保存完整 URL 参数')).toBeVisible()
  await page.getByRole('button', { name: '查看隐私设置' }).click()
  await expect(page).toHaveURL(/#\/settings/)
  await expect(page.getByRole('heading', { name: '先确认本地记录范围' })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('timeline-privacy-intro-v1')))
    .toBe('seen')
})

test('date navigation is reflected in the hash URL', async ({ page }) => {
  await page.goto('/#/timeline?date=2026-05-19')

  await expect(page.getByLabel('选择日期')).toHaveValue('2026-05-19')
  await page.getByRole('button', { name: '前一天' }).click()
  await expect(page).toHaveURL(/#\/timeline\?date=2026-05-18$/)
  await expect(page.getByLabel('选择日期')).toHaveValue('2026-05-18')
})

test('browser history restores the date from the hash URL', async ({ page }) => {
  await page.goto('/#/timeline?date=2026-05-19')
  await page.getByRole('button', { name: '前一天' }).click()
  await page.getByRole('button', { name: '前一天' }).click()
  await expect(page.getByLabel('选择日期')).toHaveValue('2026-05-17')

  await page.goBack()

  await expect(page).toHaveURL(/#\/timeline\?date=2026-05-18$/)
  await expect(page.getByLabel('选择日期')).toHaveValue('2026-05-18')
})

test('timeline keyboard shortcuts and time inputs are accessible', async ({ page }) => {
  await page.goto('/#/stats?date=2026-05-19')

  await page.keyboard.press('/')
  await expect(page).toHaveURL(/#\/timeline\?date=2026-05-19$/)
  await expect(page.getByPlaceholder('应用、标题、域名')).toBeFocused()
  await expect(page.getByLabel('开始时间')).toBeVisible()
  await expect(page.getByLabel('结束时间')).toBeVisible()

  await page.keyboard.press('Alt+ArrowRight')
  await expect(page).toHaveURL(/#\/timeline\?date=2026-05-20$/)
  await page.getByRole('heading', { name: '时间线', level: 1 }).click()
  await page.keyboard.press('t')
  await expect(page).toHaveURL(/#\/timeline\?date=2026-05-19$/)
})

test('settings and timeline do not load the ECharts runtime', async ({ page }) => {
  const requestedScripts: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'script') requestedScripts.push(request.url())
  })

  await page.goto('/#/settings?date=2026-05-19')
  await expect(page.getByRole('heading', { name: '本地设置' })).toBeVisible()
  await expect(page.getByText('数据管理')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  )
  expect(requestedScripts.some((url) => url.includes('echarts'))).toBe(false)

  requestedScripts.length = 0
  await page.getByRole('button', { name: '时间线' }).click()
  await expect(page.getByRole('heading', { name: '时间线' })).toBeVisible()
  expect(requestedScripts.some((url) => url.includes('echarts'))).toBe(false)
})

test('health reminder time windows are editable and submitted', async ({ page }) => {
  let submittedConfig: Record<string, unknown> | null = null
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/settings/config')) {
      submittedConfig = request.postDataJSON() as Record<string, unknown>
    }
  })

  await page.goto('/#/settings?date=2026-05-19')
  await page.getByRole('checkbox', { name: '限制提醒到工作时段' }).check()
  await page.getByLabel('工作时段开始时间').fill('08:30')
  await page.getByLabel('工作时段结束时间').fill('17:45')
  await page.getByRole('checkbox', { name: '启用静默时段' }).check()
  await page.getByLabel('静默时段开始时间').fill('22:00')
  await page.getByLabel('静默时段结束时间').fill('07:30')
  await page.getByRole('button', { name: '忽略应用 Visual Studio Code' }).click()
  await page.getByRole('button', { name: '忽略域名 treehole.pku.edu.cn' }).click()
  await page.getByRole('button', { name: '保存采集配置' }).click()

  await expect.poll(() => submittedConfig).not.toBeNull()
  expect(submittedConfig).toMatchObject({
    health_reminder_work_start: '08:30',
    health_reminder_work_end: '17:45',
    health_reminder_quiet_start: '22:00',
    health_reminder_quiet_end: '07:30',
    ignored_apps: ['Code.exe'],
    ignored_domains: ['treehole.pku.edu.cn'],
  })
})

test('pause until tomorrow submits the next local midnight', async ({ page }) => {
  let submittedPause: Record<string, unknown> | null = null
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/tracking/pause')) {
      submittedPause = request.postDataJSON() as Record<string, unknown>
    }
  })

  await page.goto('/#/settings?date=2026-05-19')
  await page.getByRole('button', { name: '暂停到明天' }).click()

  await expect.poll(() => submittedPause).not.toBeNull()
  const until = new Date(String(submittedPause!.until))
  expect(Number.isNaN(until.getTime())).toBe(false)
  expect(until.getHours()).toBe(0)
  expect(until.getMinutes()).toBe(0)
  expect(until.getSeconds()).toBe(0)
  expect(until.getTime()).toBeGreaterThan(Date.now())
  expect(until.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
})

test('range deletion requires two confirmations and submits inclusive dates', async ({ page }) => {
  let submittedDelete: Record<string, unknown> | null = null
  let confirmationCount = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/data/delete')) {
      submittedDelete = request.postDataJSON() as Record<string, unknown>
    }
  })
  page.on('dialog', async (dialog) => {
    confirmationCount += 1
    await dialog.accept()
  })

  await page.goto('/#/settings?date=2026-05-19')
  await page.getByLabel('开始日期').fill('2026-05-01')
  await page.getByLabel('结束日期').fill('2026-05-19')
  await page.getByRole('button', { name: '删除范围数据' }).click()

  await expect.poll(() => confirmationCount).toBe(2)
  await expect.poll(() => submittedDelete).not.toBeNull()
  expect(submittedDelete).toEqual({ from: '2026-05-01', to: '2026-05-19', all: false })
})

async function mockApi(page: Page) {
  await page.route('http://127.0.0.1:46215/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === '/health') {
      await route.fulfill({ json: envelope(health) })
      return
    }

    if (path === '/api/timeline/day') {
      await route.fulfill({ json: envelope(timelineDay) })
      return
    }

    if (path === '/api/stats/summary') {
      await route.fulfill({ json: envelope(periodSummary) })
      return
    }

    if (path === '/api/stats/apps/trend') {
      await route.fulfill({ json: envelope(appUsageTrend) })
      return
    }

    if (path === '/api/settings') {
      await route.fulfill({ json: envelope(agentSettings) })
      return
    }

    if (path === '/api/calendar/month') {
      await route.fulfill({ json: envelope(monthCalendar) })
      return
    }

    if (path === '/api/settings/autostart') {
      await route.fulfill({ json: envelope({ autostart_enabled: true }) })
      return
    }

    if (path === '/api/settings/config') {
      await route.fulfill({ json: envelope({ saved: true, requires_restart: false }) })
      return
    }

    if (path === '/api/tracking/pause') {
      await route.fulfill({
        json: envelope({ tracking_paused: true, paused_since: new Date().toISOString(), pause_until: null }),
      })
      return
    }

    if (path === '/api/tracking/resume') {
      await route.fulfill({
        json: envelope({ tracking_paused: false, paused_since: null, pause_until: null }),
      })
      return
    }

    if (path === '/api/data/delete') {
      await route.fulfill({ json: envelope({ deleted: true }) })
      return
    }

    await route.fulfill({
      status: 404,
      json: {
        ok: false,
        data: null,
        error: { code: 'not_found', message: `Unhandled mock ${path}` },
      },
    })
  })
}

function envelope<T>(data: T) {
  return { ok: true, data, error: null }
}

const timelineDay = {
  date: '2026-05-19',
  timezone: '+08:00',
  focus_segments: [
    {
      id: 1,
      started_at: '2026-05-19T02:00:00Z',
      ended_at: '2026-05-19T02:30:00Z',
      app: {
        process_name: 'msedge.exe',
        display_name: 'Microsoft Edge',
        exe_path: null,
        window_title: 'treehole.pku.edu.cn',
        is_browser: true,
      },
    },
    {
      id: 2,
      started_at: '2026-05-19T02:30:00Z',
      ended_at: '2026-05-19T03:00:00Z',
      app: {
        process_name: 'Code.exe',
        display_name: 'Visual Studio Code',
        exe_path: null,
        window_title: 'timeline-page.tsx',
        is_browser: false,
      },
    },
  ],
  browser_segments: [
    {
      id: 1,
      domain: 'treehole.pku.edu.cn',
      page_title: 'Treehole',
      browser_window_id: 1,
      tab_id: 2,
      started_at: '2026-05-19T02:00:00Z',
      ended_at: '2026-05-19T02:30:00Z',
    },
  ],
  presence_segments: [
    {
      id: 1,
      state: 'active',
      started_at: '2026-05-19T02:00:00Z',
      ended_at: '2026-05-19T03:00:00Z',
    },
  ],
}

const activeRollupReady = {
  status: 'ready',
  completed_days: 19,
  total_days: 19,
  next_date: null,
  last_error: null,
  updated_at: '2026-05-19T03:00:00Z',
}

const periodSummary = {
  date: '2026-05-19',
  timezone: '+08:00',
  today: periodStat(3600, 3600),
  week: periodStat(3600, 3600),
  month: periodStat(3600, 3600),
  active_rollup_status: activeRollupReady,
}

const appUsageTrend = {
  period: 'week',
  start_date: '2026-05-18',
  end_date: '2026-05-24',
  timezone: '+08:00',
  days: [
    '2026-05-18',
    '2026-05-19',
    '2026-05-20',
    '2026-05-21',
    '2026-05-22',
    '2026-05-23',
    '2026-05-24',
  ],
  series: [
    {
      key: 'Code.exe',
      label: 'Visual Studio Code',
      total_seconds: 3600,
      daily_seconds: [0, 1800, 1800, 0, 0, 0, 0],
      active_total_seconds: 3600,
      active_daily_seconds: [0, 1800, 1800, 0, 0, 0, 0],
    },
    {
      key: 'msedge.exe',
      label: 'Microsoft Edge',
      total_seconds: 1800,
      daily_seconds: [0, 1800, 0, 0, 0, 0, 0],
      active_total_seconds: 1800,
      active_daily_seconds: [0, 1800, 0, 0, 0, 0, 0],
    },
  ],
  active_rollup_status: activeRollupReady,
}

const monthCalendar = {
  month: '2026-05',
  timezone: '+08:00',
  days: [
    {
      date: '2026-05-19',
      focus_seconds: 3600,
      active_seconds: 3600,
      browser_seconds: 1800,
      switch_count: 2,
      active_app_seconds: 3600,
      active_browser_seconds: 1800,
      active_switch_count: 2,
      top_app: { key: 'Code.exe', label: 'Visual Studio Code', seconds: 1800 },
      top_domain: { key: 'treehole.pku.edu.cn', label: 'treehole.pku.edu.cn', seconds: 1800 },
    },
  ],
  active_rollup_status: activeRollupReady,
}

const agentSettings = {
  autostart_enabled: true,
  tray_enabled: true,
  web_ui_url: 'http://127.0.0.1:4173',
  launch_command: 'timeline.exe',
  idle_threshold_secs: 60,
  poll_interval_millis: 1000,
  health_reminder_enabled: true,
  health_reminder_threshold_secs: 3000,
  health_reminder_work_start: null,
  health_reminder_work_end: null,
  health_reminder_quiet_start: null,
  health_reminder_quiet_end: null,
  record_window_titles: true,
  record_page_titles: false,
  ignored_apps: [],
  ignored_domains: [],
  recent_apps: [
    { key: 'Code.exe', label: 'Visual Studio Code' },
    { key: 'msedge.exe', label: 'Microsoft Edge' },
  ],
  recent_domains: [{ key: 'treehole.pku.edu.cn', label: 'treehole.pku.edu.cn' }],
  monitors: [
    {
      key: 'focus',
      label: 'Focus Tracker',
      status: 'online',
      detail: '正常采集',
      last_seen: '2026-05-19T03:00:00Z',
      last_error: null,
      consecutive_failures: 0,
      restart_count: 0,
    },
  ],
  tracking_paused: false,
  paused_since: null,
  pause_until: null,
  retention_days: null,
  database_size_bytes: 262144,
  earliest_recorded_date: '2026-05-01',
  last_backup_at: '2026-05-19T02:00:00Z',
  version: '1.1.0',
  schema_version: 7,
  active_rollup_status: activeRollupReady,
}

const health = {
  service: 'timeline',
  status: 'ok',
  started_at: '2026-05-19T00:00:00Z',
  database_path: 'data/timeline.db',
  listen_addr: '127.0.0.1:46215',
  timezone: '+08:00',
  version: '1.1.0',
  schema_version: 7,
  rollup_algorithm_version: '2',
}

function periodStat(foregroundSeconds: number, activeForegroundSeconds: number) {
  return {
    focus_seconds: foregroundSeconds,
    active_seconds: activeForegroundSeconds,
    foreground_seconds: foregroundSeconds,
    active_foreground_seconds: activeForegroundSeconds,
  }
}

