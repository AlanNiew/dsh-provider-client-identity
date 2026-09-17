# AgentRouter: what its gateway actually requires

Reference for the shipped preset. Everything here was measured in 2026-09 against
`https://agentrouter.org/v1` and its domestic mirror `https://ps.air-outer.com/v1`; both answer
identically. Tools to re-measure are in [`../tools/`](../tools).

A Chinese narrative version of the same investigation is in
[agentrouter.zh.md](./agentrouter.zh.md).

---

## Working provider profile

```yaml
llm-pi-ai:
  providers:
    agentrouter:
      displayName: AgentRouter
      apiKeyEnv: AGENTROUTER_API_KEY
      api: openai-completions
      baseURL: https://ps.air-outer.com/v1     # or https://agentrouter.org/v1
      compat:
        supportsDeveloperRole: false           # required — see below
      models:
        - id: deepseek-v4-flash
          name: deepseek-v4-flash
          contextWindow: 1000000
          maxTokens: 384000
          input: [text, image]
          reasoningEfforts: { low: low, high: high, max: max }
      transport: auto
```

Plus this plugin (installed by its bundle, or manually — see [README](../README.md)).

---

## Three failures, one misleading message

All three surfaced as **"API 密钥无效 / API key is invalid"**, and none of them was about the key.
The message comes from `dsh-llm-pi-ai`:

```js
function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  ...
}
```

…rendered by the UI as `"message.failure.auth": "API 密钥无效"`. It is a regex over the error
*text*; the response body's actual meaning is never consulted.

| # | Real cause | Raw failure | Fixed by |
| --- | --- | --- | --- |
| 1 | Gateway fingerprints the client; only a Claude Code CLI `User-Agent` is admitted | `401 unauthorized client detected` | This plugin |
| 2 | Upstream knows only `system`, not OpenAI's `developer` role | `400 unknown variant 'developer'` | `compat.supportsDeveloperRole: false` |
| 3 | Following a `baseURL` the plugin's host list did not cover (and an early revision let the host check override route scoping) | `401 unauthorized client detected` | Route scope made authoritative |

Layered view of everything the route can reject:

```
DNS poisoned        -> connect timeout (agentrouter.org from mainland China)
  └─ client fingerprint -> 401 unauthorized client detected      <- #1, #3
       └─ request body  -> 400 unknown variant 'developer'        <- #2
            └─ budget   -> 402 Budget pool quota exhausted
                 └─ moderation -> 400 content-blocked
```

---

## Verified gateway facts

### Client fingerprint

| `User-Agent` | Result |
| --- | --- |
| `deepseek-harness/<ver> (+url)` — what the Harness sends | `401 unauthorized client detected` |
| `dsh/0.1.5`, `curl/8.4.0`, `OpenAI/NodeJS/4.0.0`, `Mozilla/5.0` | `401` |
| `claude-cli`, `claude-cli/1.0.0`, `claude-cli/2.1.251` | `401` |
| `claude-cli/1.0.60 (external, cli)` | **`200`** |
| `claude-cli/2.1.251 (external, cli)` | **`200`** |

- Accepted shape: `claude-cli/<x.y.z> (external, cli)`. The ` (external, cli)` suffix is required.
- Both the OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`)
  endpoints enforce it.
- `originator` / `x-app` / version headers are **not** required — the `User-Agent` alone is enough.

### Request body

| Probe | Result |
| --- | --- |
| `role=developer` / `role=system` | `400` / **`200`** |
| `max_tokens` / `max_completion_tokens` | both `200` |
| `reasoning_effort` = low/high/max/medium/minimal/none | all `200` |
| `stream` + `stream_options.include_usage` | `200` |
| `tools` with `strict: true` | `200` |
| tool result with / without `name` | both `200` |
| `image_url` parts | `200` |

Only roles `system`, `user`, `assistant`, `tool` are known (`latest_reminder` is an internal
variant). `supportsDeveloperRole: false` is therefore mandatory — pi-ai sends `developer` because
the model is declared as a reasoning model:

```js
// @earendil-works/pi-ai dist/api/openai-completions.js:910
const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
const role = useDeveloperRole ? "developer" : "system";
```

With no compat block, `supportsDeveloperRole` is auto-detected from the URL, and an unrecognised
gateway host reads as an ordinary OpenAI endpoint.

### Thinking-mode replay

A replayed assistant message must carry back the `reasoning_content` it produced:

```
400: The `reasoning_content` in the thinking mode must be passed back to the API.
```

- An **empty string is not accepted** either — it has to be the real text.
- The Harness already satisfies this natively: pi-ai stores the reasoning field name as the thinking
  block's signature (`openai-completions.js:428`), and DSH persists it as
  `replayState.blocks[].thinkingSignature`, so the text is written back on every replay.
- **No compat switch can synthesise it.** `requiresReasoningContentOnAssistantMessages: true` only
  fills an empty string, which this upstream refuses — so leave it off.
- The one case that breaks is history produced by a *different* provider, which carries no signature
  for this route. Start a fresh session there.

### Account capabilities

`GET /v1/models` advertises five models, but only one is funded on this key:

| Model | Endpoints | Callable |
| --- | --- | --- |
| `deepseek-v4-flash` | openai, anthropic | **yes** |
| `claude-opus-4-8` | anthropic, openai | `402 Budget pool quota has been exhausted` |
| `claude-opus-5` | anthropic, openai | `402` |
| `gpt-5.6-sol` | openai | `402` |
| `gpt-6-astra` | openai | `402` |

Adding the unfunded ones to `settings.yaml` only produces failures. Note the failure is `402`, not
`404`, so a client may classify it as a quota error rather than a bad model id.

An unknown model id gives `503 当前分组 default 下对于模型 <id> 无可用渠道`.

### Measured capacities

| Declared in the profile | Measured |
| --- | --- |
| `contextWindow: 1000000` | Needle recall at the **start** of a ~304k-token prompt succeeds, so the window genuinely spans at least that. Above ~304k unverified. |
| `maxTokens: 384000` | Accepted |
| `input: [text, image]` | Accepted |

### Moderation

A ~2.7k-token repeated filler prompt returns `400 content-blocked`; varied text of the same length
passes. It is a repetition detector rather than broad moderation — normal code and conversation are
unaffected, but a session that ingests a large degenerate/repetitive blob can be refused.

### Reachability

`agentrouter.org` cannot be used from mainland China: DNS returns unrelated addresses (observed
resolving into a Facebook range) and connections time out. The same gateway is published at
`ps.air-outer.com` — identical error bodies, identical `discord.gg/HgekCyHJqB` support link,
identical model list, identical fingerprint check.

Because the plugin's route scope is authoritative, pointing `baseURL` at either domain needs no
plugin change. `hosts` (which only affects model discovery) lists both.

---

## Methodology that found all three

1. **Never trust the UI's error kind.** Decode the raw failure from the session log first. The log is
   multi-frame zstd — a single `zstdDecompressSync` yields only the first frame; split on the magic
   number `28 B5 2F FD`. (Script in the [README](../README.md#troubleshooting).)
2. **Change one variable at a time.** Holding everything constant and varying only `User-Agent`
   identified failure #1 outright.
3. **Exercise the real SDK, not a hand-rolled fetch.** The Harness reaches the network through
   `new OpenAI({ baseURL, apiKey, fetch: undefined })`, so `tools/e2e.mjs` builds exactly that. A
   hand-rolled `fetch` passing proves nothing about the Harness. The same script also pins down *when*
   the SDK binds the global: a client constructed **before** the patch keeps the unpatched fetch
   (`401`), one constructed **after** works (`200`). That is why the plugin installs at boot rather
   than lazily, and why a patch reload does not revive an already-running process.
4. **Confirm in the source, not by inference.** `grep -n supportsDeveloperRole` on pi-ai answered
   failure #2 in one step.
5. **Leave a reproducible probe behind.** Every claim above has a command in `tools/`.

## Lessons

1. **Error classifiers mislabel.** `AUTH` here means "the error text contained 401 or 403", not "the
   credentials were rejected".
2. **Reserved headers are a hidden wall.** The Harness deliberately prevents a provider profile from
   overriding the attribution `User-Agent`, so this class of fix has to live below the provider
   stack. It also means any out-of-band `baseURL` change can silently disable such a fix.
3. **A fallback rule must never veto the primary rule.** Failure #3 was exactly that, and it failed
   *silently* — the provider still looked configured. When configuration looks right but has no
   effect, suspect the precedence order first.
4. **Unit tests and end-to-end tests prove different things.** The unit tests prove the function is
   correct; only the end-to-end run proves the wiring is.
5. **Mirror domains are volatile external dependencies.** Now that the route scope is authoritative,
   switching mirrors needs no code change — only model discovery cares about the host list.
