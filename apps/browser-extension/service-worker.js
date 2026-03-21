/*
 * Browser bridge for reporting active tab domain changes to the local desktop agent.
 * The worker stays intentionally small: it reports only domain and title metadata.
 */

const AGENT_BASE_URL = 'http://127.0.0.1:46215'
const HEARTBEAT_ALARM = 'timeline-heartbeat'

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: 1,
  })
  void reportCurrentTab('installed')
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: 1,
  })
  void reportCurrentTab('startup')
})

chrome.tabs.onActivated.addListener(() => {
  void reportCurrentTab('tab_activated')
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete' || tab.active) {
    void reportTab(tab, 'tab_updated')
  }
})

chrome.windows.onFocusChanged.addListener(() => {
  void reportCurrentTab('window_focus_changed')
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    void reportCurrentTab('heartbeat')
  }
})

async function reportCurrentTab(reason) {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  })

  if (!tab) {
    return
  }

  await reportTab(tab, reason)
}

async function reportTab(tab, reason) {
  const payload = buildPayload(tab)
  if (!payload) {
    return
  }

  try {
    await fetch(`${AGENT_BASE_URL}/api/events/browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    console.warn(`timeline browser bridge skipped event: ${reason}`, error)
  }
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
