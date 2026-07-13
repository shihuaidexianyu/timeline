export async function safeChromeCall(call, fallback = null) {
  try {
    return await call()
  } catch (error) {
    console.debug('timeline ignored a transient Chrome tab/window error', error)
    return fallback
  }
}

export async function focusedWindowId() {
  const window = await safeChromeCall(() => chrome.windows.getLastFocused())
  return window?.id ?? chrome.windows.WINDOW_ID_NONE
}

export async function activeTabForWindow(windowId) {
  const tabs = await safeChromeCall(
    () => chrome.tabs.query({ active: true, windowId }),
    [],
  )
  return tabs[0] ?? null
}
