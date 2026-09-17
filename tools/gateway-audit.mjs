// What can this key actually do on this gateway?
//
//   node tools/gateway-audit.mjs <api-key> [base-url] [model]
//
// A provider profile has to *declare* things the gateway never publishes —
// context window, output cap, reasoning efforts, modalities. This measures
// them, so the declarations in `settings.yaml` can be checked rather than
// guessed. Findings for AgentRouter are recorded in docs/agentrouter.md.
//
// Note it deliberately sends a large prompt; that costs tokens.

import { AGENTROUTER_PRESET } from '../index.js'

const KEY = process.env.AGENTROUTER_API_KEY ?? process.argv[2]
if (!KEY) throw new Error('usage: node tools/gateway-audit.mjs <api-key> [base-url] [model]   (or set AGENTROUTER_API_KEY)')
const BASE_URL = (process.argv[3] ?? process.env.DSH_PROBE_BASE_URL ?? 'https://ps.air-outer.com/v1').replace(/\/$/, '')
const MODEL = process.argv[4] ?? 'deepseek-v4-flash'
const UA = AGENTROUTER_PRESET.userAgent

const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'user-agent': UA }
const sys = { role: 'system', content: 'Be concise.' }
const user = { role: 'user', content: 'Say OK' }

async function chat(label, body, model = MODEL) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model, messages: [sys, user], ...body }),
      signal: AbortSignal.timeout(120000),
    })
    const json = await res.json().catch(() => ({}))
    const detail = json.error?.message ?? (json.choices ? 'ok' : JSON.stringify(json).slice(0, 80))
    console.log(`  ${res.status === 200 ? 'OK ' : 'ERR'} ${label.padEnd(38)} ${res.status} :: ${String(detail).slice(0, 120).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`  ERR ${label.padEnd(38)}     :: ${e.name}: ${e.message}`)
  }
}

/** Deterministic non-repeating prose, so moderation has nothing to latch onto. */
function variedText(targetChars, seed = 987654321) {
  const words = ('context window attention tokens sequence embedding retrieval transformer position encoding latency ' +
    'throughput inference cache prompt completion sampling nucleus temperature gradient optimizer schedule batch ' +
    'tensor matrix vector norm softmax residual layer head projection decoder encoder').split(' ')
  let s = seed
  const next = () => (s = (s * 1103515245 + 12345) & 0x7fffffff)
  const out = []
  let n = 0
  while (n < targetChars) {
    const w = words[next() % words.length]
    out.push(w)
    n += w.length + 1
    if (out.length % 20 === 0) out.push('.')
  }
  return out.join(' ')
}

console.log(`baseURL ${BASE_URL}\n`)

console.log('=== advertised models ===')
let advertised = []
try {
  const res = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${KEY}`, 'user-agent': UA } })
  const json = await res.json()
  advertised = (json.data ?? []).map((m) => m.id)
  for (const m of json.data ?? []) {
    console.log(`  ${m.id.padEnd(20)} ${(m.supported_endpoint_types ?? []).join(', ')}`)
  }
} catch (e) {
  console.log('  ERR', e.message)
}

console.log('\n=== which of them this key can actually call ===')
for (const model of advertised) await chat(`model=${model}`, { max_tokens: 32 }, model)

console.log('\n=== reasoning efforts ===')
for (const effort of ['low', 'high', 'max']) await chat(`reasoning_effort=${effort}`, { max_tokens: 64, reasoning_effort: effort })

console.log('\n=== output cap ===')
await chat('max_tokens=384000', { max_tokens: 384000 })
await chat('max_completion_tokens=384000', { max_completion_tokens: 384000 })

console.log('\n=== image modality ===')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
await chat('image_url part', {
  max_tokens: 32,
  messages: [sys, { role: 'user', content: [{ type: 'text', text: 'colour?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }],
})

console.log('\n=== content moderation: repetition vs varied text ===')
await chat('repetitive filler (~2.7k tok)', { max_tokens: 8, messages: [sys, { role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(400) }] })
await chat('varied text (~2k tok)', { max_tokens: 8, messages: [sys, { role: 'user', content: variedText(8000) }] })

console.log('\n=== needle-in-haystack at the start of a long prompt ===')
const NEEDLE = 'ZEBRA-7731'
for (const tokens of [50000, 300000]) {
  const content = `Important: the secret access word is ${NEEDLE}. Remember it.\n\n${variedText(tokens * 4)}\n\nQuestion: what was the secret access word given at the very start? Reply with just that word.`
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 256 }),
      signal: AbortSignal.timeout(300000),
    })
    if (res.status !== 200) {
      const json = await res.json().catch(() => ({}))
      console.log(`  ~${tokens} tok : ${res.status} :: ${String(json.error?.message ?? '').slice(0, 110)}`)
      continue
    }
    const msg = (await res.json()).choices?.[0]?.message
    const recalled = `${msg?.content ?? ''} ${msg?.reasoning_content ?? ''}`.includes(NEEDLE)
    console.log(`  ~${tokens} tok : 200 :: needle recalled = ${recalled}`)
  } catch (e) {
    console.log(`  ~${tokens} tok : ERR ${e.name}: ${e.message}`)
  }
}
