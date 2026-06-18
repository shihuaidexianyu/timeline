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

async function mockApi(page: Page) {
  await page.route('http://127.0.0.1:46215/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

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

const periodSummary = {
  date: '2026-05-19',
  timezone: '+08:00',
  today: { focus_seconds: 3600, active_seconds: 3600 },
  week: { focus_seconds: 3600, active_seconds: 3600 },
  month: { focus_seconds: 3600, active_seconds: 3600 },
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
    },
    {
      key: 'msedge.exe',
      label: 'Microsoft Edge',
      total_seconds: 1800,
      daily_seconds: [0, 1800, 0, 0, 0, 0, 0],
    },
  ],
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
      top_app: { key: 'Code.exe', label: 'Visual Studio Code', seconds: 1800 },
      top_domain: { key: 'treehole.pku.edu.cn', label: 'treehole.pku.edu.cn', seconds: 1800 },
    },
  ],
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
  record_window_titles: true,
  record_page_titles: true,
  ignored_apps: [],
  ignored_domains: [],
  monitors: [
    {
      key: 'focus',
      label: 'Focus Tracker',
      status: 'online',
      detail: '正常采集',
      last_seen: '2026-05-19T03:00:00Z',
    },
  ],
}

