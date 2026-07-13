import { DEFAULT_AGENT_BASE_URLS, STORAGE_KEYS } from './state.js'
import { isLoopbackHttpUrl } from './validation.js'

export async function getAgentBaseUrls() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.agentBaseUrl).catch(() => ({}))
  return [...new Set([stored[STORAGE_KEYS.agentBaseUrl], ...DEFAULT_AGENT_BASE_URLS].filter(Boolean))]
}

export async function rememberAgentBaseUrl(baseUrl) {
  if (!isLoopbackHttpUrl(baseUrl)) return false
  await chrome.storage.local.set({ [STORAGE_KEYS.agentBaseUrl]: baseUrl })
  return true
}

export async function discoverAgent(origin) {
  if (!isLoopbackHttpUrl(origin)) return false
  try {
    const response = await fetch(`${origin}/health`)
    const body = await response.json().catch(() => null)
    if (response.ok && body?.ok && body.data?.service === 'timeline') {
      return rememberAgentBaseUrl(origin)
    }
  } catch {
    // A loopback page is not necessarily the Timeline agent.
  }
  return false
}
