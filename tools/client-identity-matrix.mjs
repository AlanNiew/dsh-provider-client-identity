// Which client identity does a gateway actually accept?
//
//   node tools/client-identity-matrix.mjs <api-key> [host ...]
//
// Run this first whenever a new gateway or mirror is put behind a provider
// route: it answers "is this the same gateway, and which User-Agent does it
// want" without touching the Harness.

const KEY = process.env.AGENTROUTER_API_KEY ?? process.argv[2]
if (!KEY) throw new Error('usage: node tools/client-identity-matrix.mjs <api-key> [host ...]   (or set AGENTROUTER_API_KEY)')

const argvHosts = process.argv.slice(3)
const HOSTS = argvHosts.length > 0 ? argvHosts : ['agentrouter.org', 'ps.air-outer.com']
const UAS = [
  ['harness (what DSH sends)', 'deepseek-harness/0.1.5-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)'],
  ['claude-cli', 'claude-cli/2.1.251 (external, cli)'],
  ['none', undefined],
]

async function call(host, path, { ua, method = 'POST', body }) {
  const headers = { 'content-type': 'application/json' }
  if (ua) headers['user-agent'] = ua
  headers.authorization = `Bearer ${KEY}`
  try {
    const res = await fetch(`https://${host}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    })
    const text = (await res.text()).slice(0, 150).replace(/\s+/g, ' ')
    return `${res.status} :: ${text}`
  } catch (e) {
    return `ERR ${e.name}: ${e.message}${e.cause ? ' | ' + e.cause.message : ''}`
  }
}

const chatBody = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 16 }

for (const host of HOSTS) {
  console.log(`\n########## ${host} ##########`)
  console.log('  --- GET /v1/models ---')
  for (const [label, ua] of UAS) {
    console.log(`    ${label.padEnd(26)} -> ${(await call(host, '/v1/models', { ua, method: 'GET' })).slice(0, 160)}`)
  }
  console.log('  --- POST /v1/chat/completions ---')
  for (const [label, ua] of UAS) {
    console.log(`    ${label.padEnd(26)} -> ${(await call(host, '/v1/chat/completions', { ua, body: chatBody })).slice(0, 160)}`)
  }
}

console.log(`
Reading the output:
  a 401 "unauthorized client detected" body   -> the gateway fingerprints the client; this plugin applies
  identical errors/model lists across hosts   -> the same gateway behind different domains
  a 200 for "claude-cli"                      -> that is the identity to configure as userAgent
  a 200 for the harness UA too                -> no client gate here; the plugin is not needed
  DNS/timeout errors                          -> unreachable from here (mirror or proxy instead)
`)
