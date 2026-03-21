/*
 * Browser bridge for reporting the focused browser window's active tab.
 * Each browser window can have its own active tab, so we cache per-window state
 * and only send the active tab belonging to the currently focused window.
 */

const AGENT_BASE_URL = 'http://127.0.0.1:46215'
const HEARTBEAT_ALARM = 'timeline-heartbeat'
const FOLLOW_UP_DELAYS_MS = [250, 1200]
const activeTabsByWindow = new Map()
let focusedWindowId = chrome.windows.WINDOW_ID_NONE
let followUpTimers = []

chrome.runtime.onInstalled.addListener(() => {
  ensureHeartbeat()
  void bootstrapState('installed')
})

chrome.runtime.onStartup.addListener(() => {
  ensureHeartbeat()
  void bootstrapState('startup')
})

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId)
  cacheActiveTab(tab)

  if (activeInfo.windowId === focusedWindowId) {
    await reportTab(tab, 'tab_activated')
    scheduleFocusedWindowRefresh('tab_activated')
  }
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!tab.active || typeof tab.windowId !== 'number') {
    return
  }

  cacheActiveTab(tab)

  const changed = changeInfo.url || changeInfo.title || changeInfo.status === 'complete'
  if (changed && tab.windowId === focusedWindowId) {
    void reportTab(tab, 'active_tab_updated')
    scheduleFocusedWindowRefresh('active_tab_updated')
  }
})

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const current = activeTabsByWindow.get(removeInfo.windowId)
  if (current?.id === tabId) {
    activeTabsByWindow.delete(removeInfo.windowId)
  }
})

chrome.windows.onRemoved.addListener((windowId) => {
  activeTabsByWindow.delete(windowId)
  if (focusedWindowId === windowId) {
    focusedWindowId = chrome.windows.WINDOW_ID_NONE
  }
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  focusedWindowId = windowId
  clearFollowUpRefreshes()
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return
  }

  void reportFocusedWindowTab('window_focus_changed')
  scheduleFocusedWindowRefresh('window_focus_changed')
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    void reportFocusedWindowTab('heartbeat')
  }
})

async function bootstrapState(reason) {
  await syncActiveTabs()
  const focusedWindow = await chrome.windows.getLastFocused()
  focusedWindowId = focusedWindow?.id ?? chrome.windows.WINDOW_ID_NONE
  await reportFocusedWindowTab(reason)
  scheduleFocusedWindowRefresh(reason)
}

async function syncActiveTabs() {
  const activeTabs = await chrome.tabs.query({ active: true })
  activeTabsByWindow.clear()

  for (const tab of activeTabs) {
    cacheActiveTab(tab)
  }
}

async function reportFocusedWindowTab(reason) {
  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
    return
  }

  const [currentTab] = await chrome.tabs.query({
    active: true,
    windowId: focusedWindowId,
  })

  if (currentTab) {
    cacheActiveTab(currentTab)
    await reportTab(currentTab, reason)
    return
  }

  const cachedTab = activeTabsByWindow.get(focusedWindowId) ?? null
  if (cachedTab) {
    await reportTab(cachedTab, reason)
  }
}

function scheduleFocusedWindowRefresh(reason) {
  clearFollowUpRefreshes()

  for (const delay of FOLLOW_UP_DELAYS_MS) {
    const timer = setTimeout(() => {
      if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
        return
      }

      void reportFocusedWindowTab(`${reason}_retry_${delay}`)
    }, delay)

    followUpTimers.push(timer)
  }
}

function clearFollowUpRefreshes() {
  for (const timer of followUpTimers) {
    clearTimeout(timer)
  }

  followUpTimers = []
}

async function reportTab(tab, reason) {
  const payload = buildPayload(tab)
  if (!payload) {
    return
  }

  try {
    const response = await fetch(`${AGENT_BASE_URL}/api/events/browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.ok || result.data?.accepted === false) {
      console.warn(`timeline browser bridge rejected event: ${reason}`, {
        payload,
        status: response.status,
        result,
      })
    }
  } catch (error) {
    console.warn(`timeline browser bridge skipped event: ${reason}`, error)
  }
}

function cacheActiveTab(tab) {
  if (!tab || !tab.active || typeof tab.windowId !== 'number') {
    return
  }

  activeTabsByWindow.set(tab.windowId, tab)
}

function buildPayload(tab) {
  if (!tab.url || typeof tab.windowId !== 'number' || typeof tab.id !== 'number') {
    return null
  }

  let hostname
  try {
    hostname = new URL(tab.url).hostname
  } catch {
    return null
  }

  if (!hostname) {
    return null
  }

  return {
    domain: hostname,
    page_title: tab.title ?? null,
    browser_window_id: tab.windowId,
    tab_id: tab.id,
    observed_at: new Date().toISOString(),
  }
}

function ensureHeartbeat() {
  chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: 1,
  })
}
