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

```bash
dsh plugin --profile web add dsh-provider-client-identity
```

The package ships a Cordis bundle, so the loader row is inserted for you with the AgentRouter preset
already filled in. Restart the Harness afterwards — plugin modules are cached, so a live patch reload
is not enough.

<details>
<summary>Manual install (no bundle)</summary>

Put the package anywhere and reference the entry file from your profile's `cordis.patch.yml`. The
loader turns a relative path into a `file://` URL anchored at the patch file:

```yaml
- insert:
    - id: provider-client-identity
      name: ./plugins/dsh-provider-client-identity/index.js
      config:
        providers: [agentrouter]
        hosts: [agentrouter.org, ps.air-outer.com]
        userAgent: claude-cli/2.1.251 (external, cli)
```
</details>

## Configure

Everything is optional; the defaults are the AgentRouter preset.

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

### Using it for another gateway

1. Run `node tools/client-identity-matrix.mjs <key> <host>` to confirm the gateway fingerprints the
   client, and find which `User-Agent` it accepts.
2. Point `providers` at your route key, `hosts` at its domain(s), `userAgent` at the accepted value.

Note that repointing a route's `baseURL` needs **no** change here — the route scope is authoritative,
so a mirror works automatically. Only `hosts` (and thus model discovery) is domain-specific.

## The AgentRouter preset also needs one config change

The client identity is only the first gate. AgentRouter forwards `deepseek-*` to DeepSeek's native
backend, which is OpenAI-compatible but narrower: it does not know OpenAI's `developer` role. pi-ai
sends `developer` for a reasoning model, so the request dies with

```
400: messages[0].role: unknown variant `developer`, expected one of
     `system`, `user`, `assistant`, `tool`, `latest_reminder`
```

Fix it in the provider profile:

```yaml
llm-pi-ai:
  providers:
    agentrouter:
      baseURL: https://ps.air-outer.com/v1   # or https://agentrouter.org/v1
      compat:
        supportsDeveloperRole: false         # keep `system`
```

Full profile, plus every other request-shape finding, is in
[docs/agentrouter.md](./docs/agentrouter.md).

## How it works

| Step | Detail |
| --- | --- |
| Scope by route (**authoritative**) | An `llm/stream` listener enters an `AsyncLocalStorage` store for the configured routes. Everything driven inside it is rewritten **whatever host the route points at**. |
| Scope by host (additive) | The fetch patch also matches configured hosts by URL, covering calls that never pass through `llm/stream`. |
| Override | For a targeted request the patch **sets** `user-agent`. It is set, never skipped-if-present, because the Harness value is always there. |
| Restore | The patch is a fiber-scoped `ctx.effect`; stopping or unloading the plugin restores the original `globalThis.fetch`. |

## Verifying

```bash
npm test                                              # 14 offline checks, no network
node tools/client-identity-matrix.mjs <key>           # which identity does the gateway want?
node tools/payload-probe.mjs <key>                    # which request shapes does it accept?
node tools/gateway-audit.mjs <key>                    # models, caps, modalities, moderation, context
node tools/e2e.mjs <key>                              # end-to-end through the real OpenAI client
```

The key is read from `AGENTROUTER_API_KEY` or `argv`. Every tool takes an optional base URL, so they
work against any gateway.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| "API key is invalid" / `AUTH` | Any 401/403, including a client-fingerprint rejection | Decode the raw failure from the session log before touching the key — see below |
| `401 unauthorized client detected` | `User-Agent` not accepted | `tools/client-identity-matrix.mjs`; fix `userAgent` |
| Still failing right after changing `baseURL` | Following an earlier revision of this plugin, whose host check overrode the route scope | Upgrade; the route scope is authoritative now (`test.mjs` pins it) |
| `400 unknown variant 'developer'` | Missing `compat.supportsDeveloperRole: false` | See above |
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
