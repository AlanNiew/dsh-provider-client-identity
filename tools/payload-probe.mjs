// Which request shapes does a provider gateway actually accept?
//
//   node tools/payload-probe.mjs <api-key> [base-url] [model]
//
// A gateway that fronts a native backend (AgentRouter forwards `deepseek-*` to
// DeepSeek itself) is OpenAI-compatible but narrower than OpenAI. This pins
// down exactly which shapes it takes, so a provider profile's `compat` block
// can be written from evidence instead of a guess.
//
// Findings for AgentRouter / deepseek-v4-flash (2026-09) are recorded in
// docs/agentrouter.md. In short: `role: developer` is refused (400), so the
// profile needs `compat.supportsDeveloperRole: false`.

import { AGENTROUTER_PRESET } from '../index.js'

const KEY = process.env.AGENTROUTER_API_KEY ?? process.argv[2]
if (!KEY) throw new Error('usage: node tools/payload-probe.mjs <api-key> [base-url] [model]   (or set AGENTROUTER_API_KEY)')
const BASE_URL = (process.argv[3] ?? process.env.DSH_PROBE_BASE_URL ?? 'https://ps.air-outer.com/v1').replace(/\/$/, '')
const MODEL = process.argv[4] ?? 'deepseek-v4-flash'
const UA = AGENTROUTER_PRESET.userAgent

const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'user-agent': UA }
const system = (role) => ({ role, content: 'You are a coding agent. Be concise.' })
const user = { role: 'user', content: 'What time is it in Tokyo?' }
const tools = [{
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current time for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}]
const toolCall = { id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"city":"Tokyo"}' } }

async function probe(label, messages, extra = {}) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 128, ...extra }),
      signal: AbortSignal.timeout(60000),
    })
    const json = await res.json().catch(() => ({}))
    const detail = json.error?.message ?? json.choices?.[0]?.message?.content ?? 'ok'
    console.log(`${res.status === 200 ? 'OK ' : 'ERR'} ${label.padEnd(50)} ${res.status} :: ${String(detail).slice(0, 140).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`ERR ${label.padEnd(50)}     :: ${e.name}: ${e.message}`)
  }
}

console.log(`baseURL ${BASE_URL}  model ${MODEL}\n`)

console.log('--- system-prompt role (drives compat.supportsDeveloperRole) ---')
await probe('role=developer', [system('developer'), user])
await probe('role=system', [system('system'), user])

console.log('\n--- output-cap field ---')
await probe('max_tokens', [system('system'), user], { max_tokens: 16 })
await probe('max_completion_tokens', [system('system'), user], { max_completion_tokens: 16 })

console.log('\n--- reasoning / streaming / tools ---')
await probe('reasoning_effort=high', [system('system'), user], { reasoning_effort: 'high' })
await probe('stream + stream_options.include_usage', [system('system'), user], { stream: true, stream_options: { include_usage: true } })
await probe('tools + strict:true', [system('system'), user], { tools: [{ type: 'function', function: { ...tools[0].function, strict: true } }] })

console.log('\n--- replayed assistant shapes (thinking-mode replay) ---')
await probe('tool_calls, NO reasoning_content', [system('system'), user, { role: 'assistant', content: null, tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'call_1', content: '12:00' }], { tools })
await probe('tool_calls, reasoning_content:""', [system('system'), user, { role: 'assistant', content: null, reasoning_content: '', tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'call_1', content: '12:00' }], { tools })
await probe('tool_calls, reasoning_content:"thinking"', [system('system'), user, { role: 'assistant', content: null, reasoning_content: 'I should call get_time.', tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'call_1', content: '12:00' }], { tools })

console.log('\n--- full native loop (what a real turn looks like) ---')
{
  const first = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: MODEL, messages: [system('system'), user], max_tokens: 256, tools, tool_choice: 'auto' }),
    signal: AbortSignal.timeout(60000),
  }).then((r) => r.json())
  const msg = first.choices?.[0]?.message
  console.log(`  turn 1: tool_calls=${msg?.tool_calls?.length ?? 0} reasoning=${JSON.stringify(msg?.reasoning_content ?? null).slice(0, 50)}`)
  if (msg?.tool_calls?.length) {
    await probe('  turn 2: replay + tool result', [
      system('system'),
      user,
      { role: 'assistant', content: msg.content ?? null, reasoning_content: msg.reasoning_content, tool_calls: msg.tool_calls },
      { role: 'tool', tool_call_id: msg.tool_calls[0].id, name: 'get_time', content: '12:00' },
    ], { tools })
  }
}
