// Focused tests for the client-identity patch. No network, no Harness needed.
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AGENTROUTER_PRESET, apply, inject, name, patchFetch } from './index.js'

const UA = AGENTROUTER_PRESET.userAgent
let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

/** Record what the patched fetch would put on the wire. */
function recorder() {
  const calls = []
  const original = function (input, init) {
    calls.push({ input, init, headers: new Headers(init?.headers) })
    return Promise.resolve({ ok: true })
  }
  return { calls, original }
}

check('exports the Cordis plugin shape', () => {
  assert.equal(name, 'provider-client-identity')
  assert.deepEqual(inject, ['llm'])
  assert.equal(typeof apply, 'function')
})

check('ships the AgentRouter preset', () => {
  assert.deepEqual([...AGENTROUTER_PRESET.providers], ['agentrouter'])
  assert.ok(AGENTROUTER_PRESET.hosts.includes('agentrouter.org'))
  assert.match(AGENTROUTER_PRESET.userAgent, /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/)
})

check('replaces the Harness User-Agent on a configured host', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  await patched('https://agentrouter.org/v1/chat/completions', {
    headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://x)', authorization: 'Bearer k' },
  })
  assert.equal(calls[0].headers.get('user-agent'), UA)
  assert.equal(calls[0].headers.get('authorization'), 'Bearer k', 'other headers survive')
})

check('leaves an unconfigured host untouched', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  await patched('https://api.deepseek.com/v1/chat/completions', {
    headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://x)' },
  })
  assert.equal(calls[0].headers.get('user-agent'), 'deepseek-harness/0.1.5-rc.2 (+https://x)')
})

check('covers the model-discovery endpoint by host', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  await patched('https://agentrouter.org/v1/models')
  assert.equal(calls[0].headers.get('user-agent'), UA)
})

check('applies inside an active llm/stream store even without a readable URL', async () => {
  const { calls, original } = recorder()
  const als = new AsyncLocalStorage()
  const patched = patchFetch(original, als, UA)
  await als.run(true, () => patched({ notAUrl: true }))
  assert.equal(calls[0].headers.get('user-agent'), UA)
})

check('does not apply without a store when the URL is unreadable', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  await patched({ notAUrl: true })
  assert.equal(calls[0].headers.get('user-agent'), null)
})

check('reads headers off a Request input', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  const request = new Request('https://agentrouter.org/v1/messages', {
    method: 'POST',
    headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://x)' },
  })
  await patched(request)
  assert.equal(calls[0].headers.get('user-agent'), UA)
})

check('accepts Headers and array header bags', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  await patched('https://agentrouter.org/v1/models', { headers: new Headers({ 'user-agent': 'x' }) })
  await patched('https://agentrouter.org/v1/models', { headers: [['user-agent', 'x']] })
  assert.equal(calls[0].headers.get('user-agent'), UA)
  assert.equal(calls[1].headers.get('user-agent'), UA)
})

check('forwards untouched when the identity is already correct', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  const init = { headers: { 'user-agent': UA } }
  await patched('https://agentrouter.org/v1/models', init)
  assert.equal(calls[0].headers.get('user-agent'), UA)
  assert.equal(calls[0].init, init, 'init was forwarded, not rebuilt')
})

check('does not treat subdomains as configured hosts', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  await patched('https://api.agentrouter.org/v1/models')
  assert.equal(calls[0].headers.get('user-agent'), null, 'subdomains are out of scope until added to hosts')
})

check('covers the domestic mirror host', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA)
  await patched('https://ps.air-outer.com/v1/chat/completions', {
    headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://x)' },
  })
  assert.equal(calls[0].headers.get('user-agent'), UA)
})

check('the route scope wins over an unrecognised host', async () => {
  // Regression guard: an earlier revision let the host check override the route
  // scope, so repointing a route at any other domain silently disabled the
  // rewrite while the provider still looked configured.
  const { calls, original } = recorder()
  const als = new AsyncLocalStorage()
  const patched = patchFetch(original, als, UA)
  await als.run(true, () => patched('https://some.other-mirror.example/v1/chat/completions', {
    headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://x)' },
  }))
  assert.equal(calls[0].headers.get('user-agent'), UA)
})

check('a configured hosts list replaces the defaults', async () => {
  const { calls, original } = recorder()
  const patched = patchFetch(original, new AsyncLocalStorage(), UA, new Set(['mirror.example']))
  await patched('https://mirror.example/v1/models')
  await patched('https://agentrouter.org/v1/models')
  assert.equal(calls[0].headers.get('user-agent'), UA, 'configured host is rewritten')
  assert.equal(calls[1].headers.get('user-agent'), null, 'dropped default host is not')
})

console.log(`\n${passed} checks passed`)
