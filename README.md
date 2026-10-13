# dsh-provider-client-identity

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that lets a
provider route present **the client identity its gateway expects**.

It exists because some gateways fingerprint the *client* before they ever look at the API key, and
answer HTTP 401 for anything they do not recognise. The Harness then reports that as
**"API key is invalid"** even though the key was never examined — which sends you chasing the wrong
problem, sometimes for hours.

> ### ⚠️ Read this first
>
> This plugin **spoofs a client identity** to get past a vendor's client check. It is published as an
> interoperability shim for people who already have a legitimate account and are blocked by a client
> fingerprint rather than by policy.
>
> - Doing this may violate the provider's terms of service.
> - Your account may be rate-limited or banned.
> - It is fragile by nature: the vendor can tighten fingerprinting at any time and this will stop
>   working.
>
> You are responsible for how you use it. If the provider offers an official way to use your client
> of choice, use that instead.

---

## The problem

Harness users on AgentRouter see this, and it is wrong:

```
本轮运行失败 · API 密钥无效
```

The raw failure in the session log is:

```json
{"kind":"error","error":{
  "message":"401: {\"message\":\"unauthorized client detected, contact support for assistance at ...\"}",
  "code":"AUTH"}}
```

Two things conspire:

1. **`dsh-llm-pi-ai` guesses the failure kind from the error *text*.**
   `classifyPiAiError()` returns `AUTH` for any message containing `401`/`403`, and the UI renders
   `AUTH` as "API key is invalid". It never inspects the response body's meaning.
2. **The real gate is the `User-Agent`.** Measured against
   `https://agentrouter.org/v1/chat/completions` and `/v1/messages`:

   | `User-Agent` | Result |
   | --- | --- |
   | `deepseek-harness/<ver> (+url)` ← what DSH sends | `401 unauthorized client detected` |
   | `curl/8.4.0`, `OpenAI/NodeJS/4.0.0`, `Mozilla/5.0` | `401 unauthorized client detected` |
   | `claude-cli`, `claude-cli/1.0.0`, `claude-cli/2.1.251` | `401 unauthorized client detected` |
   | `claude-cli/1.0.60 (external, cli)` | **`200`** |
   | `claude-cli/2.1.251 (external, cli)` | **`200`** |

   The accepted shape is `claude-cli/<x.y.z> (external, cli)`. The ` (external, cli)` suffix is
   required — the same string without it is refused.

**The same key works the instant only the `User-Agent` changes.** The key was never the problem.

## Why this needs a plugin

It cannot be configured away, and that is not obvious from the docs:

- The Harness always sends its own attribution `User-Agent` (`deepseek-harness/<version> (+url)`),
  built by `attributionHeaders()`.
- `requestHeaders()` in `dsh-llm-pi-ai` builds the outgoing header set by **dropping** every
  configured `headers` entry whose name collides with an attribution name — and `user-agent` is the
  only attribution name. A provider profile's `headers: {User-Agent: ...}` is silently discarded.
- pi-ai's `mergeClientHeaders()` lets the per-request headers win, so even pi-ai's own
  Claude-Code-shaped `User-Agent` (used only on its OAuth code path) is overwritten.

The one seam below all of that is the process-wide `globalThis.fetch` the pi-ai provider stack
reaches. That is where this plugin sits — the same technique the in-tree `dsh-opencode-session`
plugin uses to add `x-opencode-session`.

> Only `user-agent` needs this. Ordinary custom headers do not collide with an attribution name, so
> they belong in the provider profile's `headers` in `settings.yaml`.

## Install

Not on npm yet, so install straight from the repository:

```bash
dsh plugin --profile web add github:AlanNiew/dsh-provider-client-identity
```

`dsh plugin` forwards to pnpm in the profile directory and then reconciles the layer stack itself:
because the package declares `dsh.bundle`, it is added to `dsh.profile.bundles` for you, and its
patch inserts the loader row with the AgentRouter preset already filled in. **Restart the Harness
afterwards** — plugin modules are cached, so a live patch reload does not re-import them.

Once published, `dsh plugin --profile web add dsh-provider-client-identity` will work identically.

To remove it again: `dsh plugin --profile web remove dsh-provider-client-identity`.

**Requirements.** Node 20+, and a `@deepseek-ai/dsh` with the two seams this relies on: the
`llm/stream` waterfall and fiber-scoped `ctx.effect`. Developed and verified against `0.1.5-rc.2`.
The package itself has no dependencies and no build step.

<details>
<summary>Manual install (no bundle, no pnpm)</summary>

Reference the entry file straight from your profile's `cordis.patch.yml`. The loader turns a relative
path into a `file://` URL anchored at the patch file:

```yaml
- insert:
    - id: provider-client-identity
      name: ./plugins/dsh-provider-client-identity/index.js
      config:
        providers: [agentrouter]
        hosts: [agentrouter.org, ps.air-outer.com]
        userAgent: claude-cli/2.1.251 (external, cli)
```

> Do not combine the two. Both routes use the loader id `provider-client-identity`, and a profile
> carrying both a manual row and the installed bundle fails to boot on a duplicate entry id. If you
> are migrating from a manual row, delete it before installing the package.
</details>

## Configure

Every field is optional; an omitted field falls back to the AgentRouter preset. An explicit list is
honoured as-is — **including an empty one**, so `hosts: []` means "no host coverage" rather than
silently reinstating the preset. To turn the plugin off entirely, set `disabled: true` on its row.

```yaml
- id: provider-client-identity
  name: dsh-provider-client-identity
  config:
    providers: [agentrouter]                                   # route keys to scope to
    hosts: [agentrouter.org, ps.air-outer.com]                 # hosts for calls outside llm/stream
    userAgent: "claude-cli/2.1.251 (external, cli)"            # the identity to present
```

| Field | Meaning |
| --- | --- |
| `providers` | Provider route keys (the `llm-pi-ai.providers` dict keys) the rewrite applies to. This is the authoritative scope. |
| `hosts` | Extra scope for calls that never pass through `llm/stream` — model discovery (`GET /v1/models`) above all. **Setting it replaces the defaults**, so list every host you need. |
| `userAgent` | The `User-Agent` to present. |
| `normalizeTools` | Also rewrite tool schemas in the outgoing JSON body: drop `strict`, and supply `required: []` when `parameters` is present. Needed by backends that validate function schemas more strictly than OpenAI (AgentRouter's DeepSeek backend). Defaults to the preset's value. |

### Using it for another gateway

1. Run `node tools/client-identity-matrix.mjs <key> <host>` to confirm the gateway fingerprints the
   client, and find which `User-Agent` it accepts.
2. Point `providers` at your route key, `hosts` at its domain(s), `userAgent` at the accepted value.

Note that repointing a route's `baseURL` needs **no** change here — the route scope is authoritative,
so a mirror works automatically. Only `hosts` (and thus model discovery) is domain-specific.

## The AgentRouter preset also needs two config changes and one patch

The client identity is only the first gate. AgentRouter forwards `deepseek-*` to DeepSeek's native
backend, which is OpenAI-compatible but narrower. Two `compat` flags are mandatory.

**1. It does not know OpenAI's `developer` role.** pi-ai sends `developer` for a reasoning model, so
the request dies with

```
400: messages[0].role: unknown variant `developer`, expected one of
     `system`, `user`, `assistant`, `tool`, `latest_reminder`
```

**2. It often omits `finish_reason` on the final streamed chunk.** pi-ai requires that marker unless
`supportsFinishReason` is `false`, and the default is `true`:

```js
if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
    throw new Error("Stream ended without finish_reason");
}
```

Left at the default, that throw surfaced 5 times on the older `agentrouter` route. On `agent-router` it
never surfaced — because the bundled proxy intercepts the same condition first and rewrites it into an
error of its own. Set the flag either way: it is what lets a stream that carries no marker be read at
all, and it is mandatory for the proxy patch below.

Fix both in the provider profile:

```yaml
llm-pi-ai:
  providers:
    agentrouter:
      baseURL: https://ps.air-outer.com/v1   # or https://agentrouter.org/v1
      compat:
        supportsDeveloperRole: false         # keep `system`
        supportsFinishReason: false          # derive the stop reason from the content
```

With `supportsFinishReason: false` pi-ai derives the reason itself — `toolUse` when a tool call was
emitted, otherwise `stop` — which is what a gateway that skips the marker intends.

Both flags must sit **inside** `compat:`, and `compat:` inside the provider entry. The loader reads
config by key and silently drops anything one level too high, so a misplaced key looks exactly like a
gateway that ignores it.

Full profile, plus every other request-shape finding, is in
[docs/agentrouter.md](./docs/agentrouter.md).

## Retry storms: the bundled proxy rewrites a truncated stream into an error

This one does not fail, it is slow: the turn completes on a later attempt, so the symptom is a model
that works but feels sluggish. Reproduce the numbers with
`node tools/retry-report.mjs --split <iso>`. Over one desktop session, `agent-router` discarded and
re-generated

| era | retries / attempts | rate |
| --- | --- | --- |
| before the two `compat` changes | 92 / 205 | 44.9% |
| after them, proxy still unpatched | 19 / 87 | 21.8% |

Treat the ratio as noisy — it moves with how busy the gateway is — and the failure-message census as
the evidence: it names the layer that raised the error. Either way the retries do not stop, because the
error is not pi-ai's. Census of every `TRANSPORT` `failure.message` in that session:

| message | count | route |
| --- | --- | --- |
| `Connection error.` | 153 | almost all `opencode-go` |
| `upstream stream ended before a completion event; this turn may be incomplete` | 109 | all `agent-router` |
| `Stream ended without finish_reason` | 17 | `agentrouter` 5, `opencode-go` 10, `open-go-new` 2 — **`agent-router` 0** |
| `terminated` | 2 | `opencode-go` |

The `agent-router` row is not pi-ai's string. It comes from `billion-context`, the proxy the desktop app
ships as an ordinary dependency (`~/.dsh/profiles/<profile>/node_modules/billion-context`), which fronts
every upstream stream. When a stream ends with neither a `finish_reason` **nor** a terminal marker, its
`emitUpstreamTruncation()` answers it:

```js
const truncated = !sawTerminal && !res.destroyed && !res.writableEnded;
if (truncated) {
    emitUpstreamTruncation(res, protocol, finalFinishReason !== undefined, log2,
                           buildTruncationDiag("eof"), transparentTruncationApplies(session));
    return;
}
```

Not transparent, and no `finish_reason` seen, it emits an in-band error chunk
(`code: "upstream_stream_truncated"`). pi-ai surfaces that message, the Harness classifies it
`TRANSPORT` and retries the whole turn — up to five attempts, 500 ms → 10 s backoff, 10% jitter. The
streams are not truncated: the content arrives complete, only the terminal marker is missing, which is
why every hand-written probe "passed" while the app kept retrying.

The proxy already implements the alternative — hand the raw bytes to the host and let it own truncation
handling — but the lane allow-list is hard-coded to the `pi` client:

```js
var TRANSPARENT_TRUNCATION_AGENTS = new Set(["pi"]);
```

The lane comes from the `x-bili-plugin` request header, and the Harness sets `x-bili-plugin: dsh`, so it
never qualifies:

```bash
node tools/enable-transparent-truncation.mjs     # allow-list becomes ["pi","dsh"]
```

That works only together with `supportsFinishReason: false` above: the stream now arrives unterminated,
so pi-ai has to derive the stop reason itself instead of throwing on it.

Trade-off, stated plainly: a response the gateway really did cut short is now accepted as complete
rather than re-run. Re-running it is what costs the third of the session. `billion-context` is an
ordinary dependency, so reinstalling or upgrading it restores the unpatched file — re-run the script
afterwards. It lives in the profile's own `node_modules`, outside the app bundle, so it is a plain
writable file rather than something packed away.

## How it works

| Step | Detail |
| --- | --- |
| Scope by route (**authoritative**) | An `llm/stream` listener enters an `AsyncLocalStorage` store for the configured routes. Everything driven inside it is rewritten **whatever host the route points at**. |
| Scope by host (additive) | The fetch patch also matches configured hosts by URL, covering calls that never pass through `llm/stream`. |
| Override | For a targeted request the patch **sets** `user-agent`. It is set, never skipped-if-present, because the Harness value is always there. |
| Restore | The patch is a fiber-scoped `ctx.effect`; stopping or unloading the plugin restores the original `globalThis.fetch`. |

## Verifying

```bash
npm test                                              # 27 offline checks, no network
node tools/client-identity-matrix.mjs <key>           # which identity does the gateway want?
node tools/payload-probe.mjs <key>                    # which request shapes does it accept?
node tools/gateway-audit.mjs <key>                    # models, caps, modalities, moderation, context
node tools/e2e.mjs <key>                              # end-to-end through the real OpenAI client
node tools/enable-transparent-truncation.mjs          # [--revert] the proxy's truncation handling
node tools/retry-report.mjs                           # how much work is discarded and re-run
```

The key is read from `AGENTROUTER_API_KEY` or `argv`. Every tool takes an optional base URL, so they
work against any gateway.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| "API key is invalid" / `AUTH` | Any 401/403, including a client-fingerprint rejection | Decode the raw failure from the session log before touching the key — see below |
| `401 unauthorized client detected` | `User-Agent` not accepted | `tools/client-identity-matrix.mjs`; fix `userAgent` |
| `401` on the route even though `hosts` lists its domain | The route key in `providers` does not match the `llm-pi-ai.providers` dict key — e.g. the route is `agent-router` while the preset says `agentrouter`. The route scope is authoritative, so it silently never fires and only the host fallback remains | Match `providers` to the **actual dict key**, character for character |
| Config "lost" after moving to the desktop app | The desktop app runs a **separate profile** (`~/.dsh/profiles/desktop`) from the web/CLI one (`~/.dsh/profiles/web`); `dsh --profile desktop --dump-config` is refused with *"managed exclusively by the Electron application"* | Re-apply the provider config and the plugin row under `profiles/desktop/cordis.patch.yml`, then restart the app |
| Still failing right after changing `baseURL` | Following an earlier revision of this plugin, whose host check overrode the route scope | Upgrade; the route scope is authoritative now (`test.mjs` pins it) |
| `400 unknown variant 'developer'` | Missing `compat.supportsDeveloperRole: false` | See above |
| `400 Invalid schema for function '...': null is not of type "array"` | The backend's tool validator rejects OpenAI's `strict` key (as `null`, `false` *or* `true`) **and** an absent `parameters.required`, which it deserialises to `null`. Several backend replicas answer and disagree, so the same request succeeds only some of the time | Set `normalizeTools: true` on the route's row — the AgentRouter preset already does |
| `TRANSPORT` over and over, "upstream stream ended before a completion event" | Not pi-ai. The bundled `billion-context` proxy turns a stream that ended without a terminal marker into an in-band error, and the Harness retries the whole turn. The gateway also omits `finish_reason` on a large fraction of streams | `node tools/enable-transparent-truncation.mjs` **and** `compat.supportsFinishReason: false` — both, or the retry comes straight back. Direct probes do **not** reproduce it: they read the content, which is intact |
| The proxy patch stops applying after a dependency upgrade | `billion-context` is an ordinary npm dependency; reinstalling or upgrading it restores the unpatched `dist/index.js` | Re-run `tools/enable-transparent-truncation.mjs`; it is idempotent and reports what it found |
| A config key appears to have no effect | The loader reads config by key and drops anything outside its parent silently — e.g. `normalizeTools` written at the loader-row level instead of under `config:` | Check the nesting; `npm test` pins the shipped bundle's layout |
| `400 reasoning_content ... must be passed back` | Thinking-mode replay of an assistant turn that has no reasoning (typically history produced by a *different* provider) | Start a fresh session |
| Plugin seems inert | Plugin modules are cached; a patch reload does not re-import them | Restart the Harness |

**Reading the raw failure.** The Harness UI only shows the classified kind. The truth is in the
session log, which is multi-frame zstd — a single `zstdDecompressSync` returns only the first frame,
so split on the magic number `28 B5 2F FD`:

```bash
node -e "
const zlib=require('zlib'),fs=require('fs');
const buf=fs.readFileSync(process.argv[1]);
const offs=[];
for(let i=0;i<=buf.length-4;i++) if(buf[i]===0x28&&buf[i+1]===0xb5&&buf[i+2]===0x2f&&buf[i+3]===0xfd) offs.push(i);
const out=[];
for(let k=0;k<offs.length;k++){
  const s=offs[k], e=(k+1<offs.length)?offs[k+1]:buf.length;
  try{ out.push(zlib.zstdDecompressSync(buf.subarray(s,e))); }catch(e){}
}
fs.writeFileSync(process.argv[2], Buffer.concat(out));
" session.v3.jsonl.zstd session.jsonl
grep -o '"message":"[^"]*"' session.jsonl | tail -20
```

## Limits

- **Spoofing is deliberate and narrowly scoped** — only requests belonging to the configured routes
  or hosts are touched.
- **The vendor can break it.** If AgentRouter moves beyond `User-Agent` to other headers, `userAgent`
  is not enough and the plugin needs extending. Check with `tools/client-identity-matrix.mjs` first.
- **Host matching is exact.** Subdomains are not covered; add them explicitly.
- **The patch only reaches clients built after it is installed.** The OpenAI SDK binds
  `globalThis.fetch` when a client is *constructed*, not when a request is made — `tools/e2e.mjs`
  builds one client either side of the patch and shows exactly that (401 before, 200 after). The
  plugin installs at boot, so every client pi-ai constructs per request picks it up; this only
  matters if something swaps the global at runtime.
- **Errors will still be mislabelled.** This plugin fixes one cause of the `AUTH` misclassification,
  not the classifier. Any future 401/403 will still display as "API key is invalid".

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with AgentRouter or DeepSeek.
