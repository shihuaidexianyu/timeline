export const STORAGE_KEYS = {
  agentBaseUrl: 'agent-base-url',
  connection: 'connection-state',
  paused: 'tracking-paused',
}

export const DEFAULT_AGENT_BASE_URLS = [
  'http://127.0.0.1:46215',
  'http://localhost:46215',
  'http://[::1]:46215',
]

export async function setConnectionState(patch) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.connection).catch(() => ({}))
  const current = stored[STORAGE_KEYS.connection] ?? {}
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [STORAGE_KEYS.connection]: next }).catch(() => {})
  await updateBadge(next.status, next.paused)
  return next
}

export async function getConnectionState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.connection,
    STORAGE_KEYS.agentBaseUrl,
  ]).catch(() => ({}))
  return {
    status: 'offline',
    lastSuccessAt: null,
    currentDomain: null,
    paused: false,
    agentBaseUrl: stored[STORAGE_KEYS.agentBaseUrl] ?? null,
    ...(stored[STORAGE_KEYS.connection] ?? {}),
  }
}

export async function updateBadge(status, paused = false) {
  const text = paused ? 'Ⅱ' : status === 'online' ? '●' : '!'
  const color = paused ? '#c97b4c' : status === 'online' ? '#2e9b8c' : '#c95a6b'
  await Promise.all([
    chrome.action.setBadgeText({ text }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ color }).catch(() => {}),
  ])
}
