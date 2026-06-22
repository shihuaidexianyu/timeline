/*
 * Browser bridge for reporting the focused browser window's active tab.
 * Each browser window can have its own active tab, so we cache per-window state
 * and only send the active tab belonging to the currently focused window.
 * The agent base URL is persisted after a successful request or after the
 * self-hosted dashboard is discovered on a loopback origin.
 */

const AGENT_BASE_URL_STORAGE_KEY = 'agent-base-url'
const DEFAULT_AGENT_BASE_URLS = ['http://127.0.0.1:46215', 'http://localhost:46215']
const HEARTBEAT_ALARM = 'timeline-heartbeat'
const FOLLOW_UP_DELAYS_MS = [250, 1200, 4000]
const REPORT_DEDUP_WINDOW_MS = 1800
const activeTabsByWindow = new Map()
let focusedWindowId = chrome.windows.WINDOW_ID_NONE
let followUpTimers = []
let lastReportSignature = null
let lastReportAtMs = 0

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

  await syncFocusedWindowId()

  if (activeInfo.windowId === focusedWindowId) {
    await reportTab(tab, 'tab_activated')
    scheduleFocusedWindowRefresh('tab_activated')
  }
})

chrome.tabs.onHighlighted.addListener(async (highlightInfo) => {
  await syncFocusedWindowId()
  if (highlightInfo.windowId !== focusedWindowId) {
    return
  }

  await reportFocusedWindowTab('tab_highlighted')
  scheduleFocusedWindowRefresh('tab_highlighted')
})

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!tab.active || typeof tab.windowId !== 'number') {
    return
  }

  cacheActiveTab(tab)

  const changed = changeInfo.url || changeInfo.title || changeInfo.status === 'complete'
  await syncFocusedWindowId()

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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'timeline-discover-agent' && typeof message.origin === 'string') {
    void rememberDiscoveredAgentOrigin(message.origin)
  }
})

async function bootstrapState(reason) {
  await syncActiveTabs()
  await syncFocusedWindowId()
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
  await syncFocusedWindowId()
  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
    return
  }

  // Skip reporting when the focused browser window is minimized — the user
  // isn't looking at it, and the agent's foreground-visibility check would
  // reject the event anyway. This avoids wasted requests and prevents
  // stale-tab reporting during minimize transitions.
  try {
    const focusedWindow = await chrome.windows.get(focusedWindowId)
    if (focusedWindow?.state === 'minimized') {
      return
    }
  } catch {
    // Window may have been closed between getLastFocused and get; treat as
    // not focused and skip.
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

async function syncFocusedWindowId() {
  const focusedWindow = await chrome.windows.getLastFocused()
  focusedWindowId = focusedWindow?.id ?? chrome.windows.WINDOW_ID_NONE
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

  if (shouldSkipDuplicateReport(payload, reason)) {
    return
  }

  const agentBaseUrls = await getAgentBaseUrls()

  for (const agentBaseUrl of agentBaseUrls) {
    const result = await postBrowserEvent(agentBaseUrl, payload)

    if (result.kind === 'network_error') {
      continue
    }

    await rememberAgentBaseUrl(agentBaseUrl)

    if (result.kind === 'rejected') {
      console.warn(`timeline browser bridge rejected event: ${reason}`, {
        payload,
        agent_base_url: agentBaseUrl,
        status: result.status,
        result: result.body,
      })
    }

    return
  }

  console.warn(`timeline browser bridge skipped event: ${reason}`, {
    payload,
    tried_agent_base_urls: agentBaseUrls,
  })
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

  let parsedUrl
  try {
    parsedUrl = new URL(tab.url)
  } catch {
    return null
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return null
  }

  const hostname = parsedUrl.hostname
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

async function getAgentBaseUrls() {
  const storedBaseUrl = await readStoredAgentBaseUrl()
  return uniqueValues([storedBaseUrl, ...DEFAULT_AGENT_BASE_URLS].filter(Boolean))
}

async function readStoredAgentBaseUrl() {
  const stored = await chrome.storage.local.get(AGENT_BASE_URL_STORAGE_KEY)
  return typeof stored[AGENT_BASE_URL_STORAGE_KEY] === 'string'
    ? stored[AGENT_BASE_URL_STORAGE_KEY]
    : null
}

async function rememberAgentBaseUrl(agentBaseUrl) {
  if (!isLoopbackHttpUrl(agentBaseUrl)) {
    return
  }

  await chrome.storage.local.set({
    [AGENT_BASE_URL_STORAGE_KEY]: agentBaseUrl,
  })
}

async function rememberDiscoveredAgentOrigin(origin) {
  if (!isLoopbackHttpUrl(origin)) {
    return
  }

  try {
    const response = await fetch(`${origin}/health`)
    const result = await response.json().catch(() => null)
    if (
      response.ok &&
      result?.ok &&
      ['timeline', 'timeline-agent'].includes(result.data?.service)
    ) {
      await rememberAgentBaseUrl(origin)
    }
  } catch {
    // Ignore local pages that are not served by the timeline agent.
  }
}

async function postBrowserEvent(agentBaseUrl, payload) {
  try {
    const response = await fetch(`${agentBaseUrl}/api/events/browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Timeline-Extension': 'browser-bridge',
      },
      body: JSON.stringify(payload),
    })

    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.ok || result.data?.accepted === false) {
      return {
        kind: 'rejected',
        status: response.status,
        body: result,
      }
    }

    return {
      kind: 'success',
      status: response.status,
      body: result,
    }
  } catch (error) {
    return {
      kind: 'network_error',
      error,
    }
  }
}

function shouldSkipDuplicateReport(payload, reason) {
  // Keep heartbeat authoritative; only throttle bursty follow-up retries and UI events.
  if (reason === 'heartbeat') {
    return false
  }

  const signature = `${payload.domain}|${payload.browser_window_id}|${payload.tab_id}`
  const now = Date.now()

  const isDuplicateBurst =
    lastReportSignature === signature && now - lastReportAtMs < REPORT_DEDUP_WINDOW_MS

  lastReportSignature = signature
  lastReportAtMs = now

  return isDuplicateBurst
}

function uniqueValues(values) {
  return Array.from(new Set(values))
}

function isLoopbackHttpUrl(value) {
  try {
    const parsedUrl = new URL(value)
    return (
      ['http:', 'https:'].includes(parsedUrl.protocol) &&
      ['127.0.0.1', 'localhost'].includes(parsedUrl.hostname)
    )
  } catch {
    return false
  }
}
