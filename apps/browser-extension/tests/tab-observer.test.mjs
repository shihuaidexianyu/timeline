import test from 'node:test'
import assert from 'node:assert/strict'
import { activeTabForWindow, focusedWindowId, safeChromeCall } from '../tab-observer.js'

test('transient tab and window disappearance returns safe fallbacks', async () => {
  globalThis.chrome = {
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => { throw new Error('window disappeared') },
    },
    tabs: {
      query: async () => { throw new Error('tab disappeared') },
    },
  }
  const originalDebug = console.debug
  console.debug = () => {}
  try {
    assert.equal(await focusedWindowId(), -1)
    assert.equal(await activeTabForWindow(42), null)
    assert.equal(await safeChromeCall(async () => { throw new Error('gone') }, 'fallback'), 'fallback')
  } finally {
    console.debug = originalDebug
    delete globalThis.chrome
  }
})
