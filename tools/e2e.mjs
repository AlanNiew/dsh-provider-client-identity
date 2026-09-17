// End-to-end proof that the patch reaches the wire through the *real* provider
// stack, not just through a hand-rolled fetch call.
//
//   node tools/e2e.mjs <api-key> [base-url]
//
// Part 1 uses plain fetch and always runs: it shows the same key being refused
// with the Harness User-Agent and accepted with the configured one.
//
// Part 2 is the stronger claim — it builds the exact client pi-ai's
// `openai-completions` adapter builds (`new OpenAI({ baseURL, apiKey, fetch })`
// with `fetch` undefined) and confirms the global fetch patch is what the SDK
// picks up. It needs to resolve the `openai` copy the Harness ships; when that
// cannot be found it says so and skips rather than failing.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENTROUTER_PRESET, patchFetch } from '../index.js'

const KEY = process.env.AGENTROUTER_API_KEY ?? process.argv[2]
if (!KEY) throw new Error('usage: node tools/e2e.mjs <api-key> [base-url]   (or set AGENTROUTER_API_KEY)')
const BASE_URL = process.argv[3] ?? process.env.DSH_PROBE_BASE_URL ?? 'https://ps.air-outer.com/v1'
const HARNESS_UA = 'deepseek-harness/0.1.5-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)'
const CLIENT_UA = AGENTROUTER_PRESET.userAgent

console.log(`baseURL : ${BASE_URL}`)
console.log(`identity: ${CLIENT_UA}\n`)

// --- Part 1: plain fetch, no SDK required -----------------------------------
async function raw(label, ua) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'user-agent': ua },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'reply OK' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(60000),
    })
    const text = (await res.text()).slice(0, 130).replace(/\s+/g, ' ')
    console.log(`raw fetch  ${label.padEnd(18)} ${res.status} :: ${text}`)
  } catch (e) {
    console.log(`raw fetch  ${label.padEnd(18)} ERR :: ${e.name}: ${e.message}`)
  }
}
await raw('harness UA', HARNESS_UA)
await raw('configured UA', CLIENT_UA)

// --- Part 2: the real OpenAI client, as pi-ai constructs it -----------------
function resolveOpenAI() {
  const anchors = [
    process.env.DSH_PI_AI_ENTRY,
    process.env.DSH_HARNESS_ROOT && join(process.env.DSH_HARNESS_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js'),
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js'),
  ].filter(Boolean)
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      const mod = createRequire(pathToFileURL(anchor).href)('openai')
      return { mod, anchor }
    } catch {
      // try the next anchor
    }
  }
  return undefined
}

const resolved = resolveOpenAI()
if (resolved === undefined) {
  console.log('\nsdk path   skipped :: could not locate the openai package the Harness ships.')
  console.log('           Set DSH_PI_AI_ENTRY to .../@earendil-works/pi-ai/dist/api/openai-completions.js to enable it.')
} else {
  console.log(`\nsdk path   ${resolved.anchor}`)
  const OpenAI = resolved.mod.OpenAI ?? resolved.mod.default ?? resolved.mod

  const build = () => new OpenAI({
    baseURL: BASE_URL,
    apiKey: KEY,
    defaultHeaders: { 'user-agent': HARNESS_UA },
    fetch: undefined, // exactly what pi-ai passes
  })

  // The SDK binds `globalThis.fetch` when the *client is constructed*, not when
  // a request is made (verified below — the first client is built before the
  // patch and keeps the unpatched fetch). That is fine for the plugin, which
  // installs at boot, long before pi-ai constructs its per-request client; it
  // is only a trap for anything that swaps the global afterwards.
  const builtBeforePatch = build()

  const originalFetch = globalThis.fetch
  globalThis.fetch = patchFetch(originalFetch, new AsyncLocalStorage(), CLIENT_UA)

  const builtAfterPatch = build()

  try {
    await builtBeforePatch.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'reply OK' }],
      max_tokens: 16,
    })
    console.log('sdk        built before patch 200 :: unexpectedly accepted — SDK may now bind fetch lazily')
  } catch (error) {
    console.log(`sdk        built before patch 401-ish :: ${String(error.message).slice(0, 90)}`)
  }

  try {
    const r = await builtAfterPatch.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'reply OK' }],
      max_tokens: 32,
    })
    console.log(`sdk        built after patch  200 :: ${JSON.stringify(r.choices[0].message).slice(0, 110)}`)
  } catch (error) {
    console.log(`sdk        built after patch  FAIL :: ${String(error.message).slice(0, 180)}`)
  }

  try {
    const stream = await builtAfterPatch.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Say: one two three' }],
      max_tokens: 64,
      stream: true,
    })
    let chunks = 0
    for await (const _ of stream) chunks += 1
    console.log(`sdk        streaming         ${chunks > 0 ? `200, ${chunks} chunks` : 'no chunks'}`)
  } catch (error) {
    console.log(`sdk        streaming         FAIL :: ${String(error.message).slice(0, 180)}`)
  }
}
