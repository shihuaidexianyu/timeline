import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverAgent, getAgentBaseUrls } from '../discovery.js'

test('agent discovery accepts verified loopback health and remembers it', async () => {
  const storage = createStorage()
  globalThis.chrome = { storage: { local: storage } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => ({
    ok: url === 'http://localhost:46215/health',
    json: async () => ({ ok: true, data: { service: 'timeline' }, error: null }),
  })
  try {
    assert.equal(await discoverAgent('http://localhost:46215'), true)
    const urls = await getAgentBaseUrls()
    assert.equal(urls[0], 'http://localhost:46215')
    assert.equal(new Set(urls).size, urls.length)
  } finally {
    globalThis.fetch = originalFetch
    delete globalThis.chrome
  }
})

test('agent discovery rejects non-loopback origins without fetching', async () => {
  let fetched = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetched = true
    throw new Error('must not fetch')
  }
  try {
    assert.equal(await discoverAgent('http://192.168.1.5:46215'), false)
    assert.equal(fetched, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function createStorage() {
  const values = {}
  return {
    async get(keys) {
      const selected = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(selected.filter((key) => key in values).map((key) => [key, values[key]]))
    },
    async set(patch) {
      Object.assign(values, patch)
    },
  }
}
