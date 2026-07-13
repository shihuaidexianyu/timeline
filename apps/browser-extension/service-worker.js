import { discoverAgent, getAgentBaseUrls } from './discovery.js'
import { setConnectionState } from './state.js'
import { activeTabForWindow, focusedWindowId, safeChromeCall } from './tab-observer.js'
import { enqueueReport } from './transport.js'
import { buildPayload, createReportDeduper } from './validation.js'

const HEARTBEAT_ALARM = 'timeline-heartbeat'
const FOLLOW_UP_DELAYS_MS = [250, 1200, 4000]
const REPORT_DEDUP_WINDOW_MS = 1800
const activeTabsByWindow = new Map()
let currentFocusedWindowId = chrome.windows.WINDOW_ID_NONE
let followUpTimers = []
const reportDeduper = createReportDeduper(REPORT_DEDUP_WINDOW_MS)

chrome.runtime.onInstalled.addListener(() => start('installed'))
chrome.runtime.onStartup.addListener(() => start('startup'))

chrome.tabs.onActivated.addListener((info) => void handleTabActivated(info))
chrome.tabs.onHighlighted.addListener((info) => void handleTabHighlighted(info))
chrome.tabs.onUpdated.addListener((_id, change, tab) => void handleTabUpdated(change, tab))
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (activeTabsByWindow.get(info.windowId)?.id === tabId) activeTabsByWindow.delete(info.windowId)
})
chrome.windows.onRemoved.addListener((windowId) => {
  activeTabsByWindow.delete(windowId)
  if (currentFocusedWindowId === windowId) currentFocusedWindowId = chrome.windows.WINDOW_ID_NONE
})
chrome.windows.onFocusChanged.addListener((windowId) => {
  currentFocusedWindowId = windowId
  clearFollowUps()
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    void reportFocusedWindowTab('window_focus_changed')
    scheduleFollowUps('window_focus_changed')
  }
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) void reportFocusedWindowTab('heartbeat')
})
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'timeline-discover-agent' && typeof message.origin === 'string') {
    void discoverAgent(message.origin)
  }
})

void start('worker_started')

async function start(reason) {
  await safeChromeCall(() => chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 }))
  const tabs = await safeChromeCall(() => chrome.tabs.query({ active: true }), [])
  activeTabsByWindow.clear()
  tabs.forEach(cacheActiveTab)
  currentFocusedWindowId = await focusedWindowId()
  await reportFocusedWindowTab(reason)
  scheduleFollowUps(reason)
}

async function handleTabActivated(info) {
  const tab = await safeChromeCall(() => chrome.tabs.get(info.tabId))
  if (!tab) return
  cacheActiveTab(tab)
  currentFocusedWindowId = await focusedWindowId()
  if (info.windowId === currentFocusedWindowId) {
    await reportTab(tab, 'tab_activated')
    scheduleFollowUps('tab_activated')
  }
}

async function handleTabHighlighted(info) {
  currentFocusedWindowId = await focusedWindowId()
  if (info.windowId === currentFocusedWindowId) {
    await reportFocusedWindowTab('tab_highlighted')
    scheduleFollowUps('tab_highlighted')
  }
}

async function handleTabUpdated(change, tab) {
  if (!tab?.active || !Number.isInteger(tab.windowId)) return
  cacheActiveTab(tab)
  const changed = change.url || change.title || change.status === 'complete'
  if (!changed) return
  currentFocusedWindowId = await focusedWindowId()
  if (tab.windowId === currentFocusedWindowId) {
    await reportTab(tab, 'active_tab_updated')
    scheduleFollowUps('active_tab_updated')
  }
}

async function reportFocusedWindowTab(reason) {
  currentFocusedWindowId = await focusedWindowId()
  if (currentFocusedWindowId === chrome.windows.WINDOW_ID_NONE) return
  const tab = await activeTabForWindow(currentFocusedWindowId) ??
    activeTabsByWindow.get(currentFocusedWindowId)
  if (tab) {
    cacheActiveTab(tab)
    await reportTab(tab, reason)
  }
}

async function reportTab(tab, reason) {
  const payload = buildPayload(tab)
  if (!payload) {
    await setConnectionState({ currentDomain: null })
    return
  }
  if (shouldSkipDuplicate(payload, reason)) return
  const result = await enqueueReport(payload, await getAgentBaseUrls())
  if (result.kind === 'network_error') {
    console.warn('timeline browser bridge cannot reach the local agent', { reason })
  }
}

function cacheActiveTab(tab) {
  if (tab?.active && Number.isInteger(tab.windowId)) activeTabsByWindow.set(tab.windowId, tab)
}

function shouldSkipDuplicate(payload, reason) {
  return reportDeduper.shouldSkip(payload, reason)
}

function scheduleFollowUps(reason) {
  clearFollowUps()
  followUpTimers = FOLLOW_UP_DELAYS_MS.map((delay) => setTimeout(() => {
    if (currentFocusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      void reportFocusedWindowTab(`${reason}_follow_up_${delay}`)
    }
  }, delay))
}

function clearFollowUps() {
  followUpTimers.forEach(clearTimeout)
  followUpTimers = []
}
