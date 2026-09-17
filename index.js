// dsh-provider-client-identity
//
// Host plugin: let a provider route present the client identity its gateway
// expects.
//
// Some gateways fingerprint the *client* before they ever look at the API key,
// and answer HTTP 401 for anything they do not recognise. AgentRouter is one:
// every request whose `User-Agent` is not a Claude Code CLI build gets
//
//   {"error":{"message":"unauthorized client detected, contact support for
//    assistance at ..."},"message":"UNAUTHENTICATED","success":false,
//    "type":"unauthorized_client_error"}
//
// That is a trap for a Harness user, because `dsh-llm-pi-ai` classifies any
// error text containing 401/403 as code `AUTH`, and the UI renders `AUTH` as
// "API 密钥无效 / API key is invalid". A perfectly valid key therefore looks
// invalid, and the reported cause points at the wrong thing.
//
// Configuration cannot fix it:
//   - The Harness always sends its own attribution User-Agent
//     (`deepseek-harness/<version> (+url)`), built by `attributionHeaders()`.
//   - `requestHeaders()` in `dsh-llm-pi-ai` builds the outgoing header set by
//     *dropping* every configured `headers` entry whose name collides with an
//     attribution name — and `user-agent` is the only attribution name. A
//     provider profile's `headers: {User-Agent: ...}` is silently discarded.
//   - pi-ai's `mergeClientHeaders()` lets the per-request `options.headers`
//     win, so even pi-ai's own Claude-Code-shaped User-Agent (used only on its
//     OAuth code path) is overwritten by the Harness value.
//
// The one seam below all of that is the process-wide `globalThis.fetch` the
// pi-ai provider stack reaches — which is where this plugin sits, the same way
// the in-tree `dsh-opencode-session` plugin adds `x-opencode-session`.
//
// Note that this is the *only* header that needs a plugin. Ordinary custom
// headers do not collide with an attribution name, so they belong in the
// provider profile's `headers` in `settings.yaml`.
//
// Scope, narrowest first:
//   1. An `llm/stream` listener enters an AsyncLocalStorage store for the
//      configured provider routes only. Everything driven inside that store is
//      rewritten **whatever host the route points at** — which is what lets a
//      route be repointed at a mirror without touching this plugin.
//   2. The fetch patch also matches configured hosts by URL, covering calls
//      that never pass through `llm/stream`: model discovery
//      (`GET /v1/models`), and any auxiliary request built outside the route.
//
// The fetch patch is a fiber-scoped `ctx.effect`, so stopping, updating, or
// unloading the plugin restores the original `globalThis.fetch`.

import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'provider-client-identity'

// Activate only after the abstract `llm` service exists, so the waterfall
// event we listen on is already registered by its provider.
export const inject = ['llm']

/**
 * Default configuration: the AgentRouter preset.
 *
 * AgentRouter's gateway admits only the Claude Code CLI shape
 * `claude-cli/<x.y.z> (external, cli)`. Probed against both its
 * OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible
 * (`/v1/messages`) endpoints: the same string without the ` (external, cli)`
 * suffix, and every non-`claude-cli` value, is refused.
 *
 * `agentrouter.org` cannot be reached from mainland China (DNS returns
 * unrelated addresses and connections time out), so the same gateway is also
 * published at a domestic mirror, `ps.air-outer.com`, behind an identical
 * fingerprint check. Both hosts are listed so model discovery works on either.
 *
 * Override any field through the plugin's `config`; see `README.md`.
 */
export const AGENTROUTER_PRESET = Object.freeze({
  providers: Object.freeze(['agentrouter']),
  hosts: Object.freeze(['agentrouter.org', 'ps.air-outer.com']),
  userAgent: 'claude-cli/2.1.251 (external, cli)',
})

/** Provider routes the override is scoped to when none is configured. */
const DEFAULT_PROVIDERS = AGENTROUTER_PRESET.providers
/** Hosts treated as belonging to the configured routes when none is set. */
const DEFAULT_HOSTS = AGENTROUTER_PRESET.hosts
/** The client identity presented when none is configured. */
const DEFAULT_USER_AGENT = AGENTROUTER_PRESET.userAgent

/**
 * Resolve the effective configuration.
 *
 * Only an **omitted** field falls back to the preset. An explicitly supplied
 * list is honoured as-is, including an empty one — `hosts: []` means "no host
 * coverage", not "silently reinstate the AgentRouter preset". To turn the whole
 * plugin off, set `disabled: true` on its loader row instead.
 *
 * @param config - the plugin's `config` block.
 * @returns the resolved route keys, hosts, and client identity.
 */
export function resolveConfig(config = {}) {
  const asList = (value, fallback) => Array.isArray(value)
    ? value.map((entry) => String(entry))
    : [...fallback]
  const providers = asList(config.providers, DEFAULT_PROVIDERS)
  const hosts = asList(config.hosts, DEFAULT_HOSTS).map((host) => host.toLowerCase())
  const userAgent = typeof config.userAgent === 'string' && config.userAgent.length > 0
    ? config.userAgent
    : DEFAULT_USER_AGENT
  return { providers: new Set(providers), hosts: new Set(hosts), userAgent }
}

/** Read the request URL from whatever `fetch` was handed. */
function requestUrl(input) {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return undefined
}

/** True when a request URL targets one of the configured hosts. */
function isConfiguredHost(url, hosts) {
  try {
    return hosts.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store. Async generators and the promises they create
 * inherit the store as long as the generator body is driven from a pull made
 * inside `als.run`, which is exactly what this wrapper does per `next()`.
 */
export function withStore(iterable, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(true, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(true, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/**
 * Build a patched fetch that presents the configured client identity.
 *
 * The route scope is authoritative: a request driven inside an `llm/stream`
 * store already belongs to a configured provider route, and is rewritten
 * whatever host that route points at — which is what makes a mirror work
 * without being named here. The host set only adds coverage for calls that
 * never pass through `llm/stream`, model discovery above all. Anything else
 * passes through untouched.
 *
 * The header is *set*, never skipped-if-present: the Harness attribution
 * User-Agent is always on the request, so "leave an existing value alone"
 * would mean this patch never applies.
 *
 * @param original - the fetch to wrap.
 * @param als - the store whose presence marks a route-scoped request.
 * @param userAgent - the identity to present.
 * @param hosts - hosts treated as belonging to the configured routes.
 */
export function patchFetch(original, als, userAgent, hosts = new Set(DEFAULT_HOSTS)) {
  return function patchedFetch(input, init) {
    const url = requestUrl(input)
    const targeted = als.getStore() !== undefined
      || (url !== undefined && isConfiguredHost(url, hosts))
    if (!targeted) return original.apply(this, arguments)

    let headers
    try {
      headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
    } catch {
      // An unreadable header bag is not ours to repair; send it as-is.
      return original.apply(this, arguments)
    }
    if (headers.get('user-agent') === userAgent) return original.apply(this, arguments)
    headers.set('user-agent', userAgent)
    return original.call(this, input, { ...init, headers })
  }
}

export function apply(ctx, config) {
  const { providers, hosts, userAgent } = resolveConfig(config)
  const als = new AsyncLocalStorage()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[provider-client-identity] globalThis.fetch is unavailable; cannot present the configured client identity')
    return
  }

  const patched = patchFetch(originalFetch, als, userAgent, hosts)

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[provider-client-identity] sending "%s" for providers [%s] on hosts [%s]',
      userAgent,
      [...providers].join(', '),
      [...hosts].join(', '),
    )
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'provider-client-identity.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()

    // Reaching the adapter is the only way the actual HTTP request happens;
    // `next()` returns the downstream (lazy) stream. Call it exactly once,
    // then drive its iterator from inside the store.
    const downstream = next()
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream
    return withStore(downstream, als)
  }, { prepend: true })
}

export default { name, inject, apply }
