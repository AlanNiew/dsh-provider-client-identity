# AgentRouter 接入 DSH 排查全记录

> 记录 2026-09 把 AgentRouter 接进 DeepSeek Harness 的完整过程。三个故障症状相同、根因完全不同。
> 目的：下次出问题时，不用从零开始推。
>
> 配套文件：[README.zh.md](../README.zh.md)（安装与配置）、`cordis.patch.yml`（插件 bundle）、
> 上一层 `settings.yaml`（provider 配置）、`tools/`（可复现的探针）。
>
> 这份文档是**案例记录**；面向其它网关的通用用法请看 README。

---

## 0. 结论速查

**「API 密钥无效」这条提示几乎从来不等于密钥无效。**

三个独立故障，症状全是同一句话：

| # | 真实原因 | 真实报错 | 修复位置 |
|---|---|---|---|
| 1 | AgentRouter 做客户端指纹识别，只放行 Claude Code CLI 的 UA | `401 unauthorized client detected` | 插件（fetch 层改 UA） |
| 2 | 上游只认 `system`，pi-ai 发了 OpenAI 的 `developer` 角色 | `400 unknown variant 'developer'` | `settings.yaml` 的 `compat` |
| 3 | 插件域名白名单没覆盖国内镜像（且判定主次写反了） | `401 unauthorized client detected` | 插件（作用域判定） |

一句话概括三者：**DSH 把任何含 `401`/`403` 的报错统一归类为 `AUTH`，UI 渲染成「API 密钥无效」**，
于是「客户端被拒」「请求体不合法」「域名没覆盖」全被包装成同一句错误文案。

---

## 1. 为什么 UI 文案会骗人

`dsh-llm-pi-ai/lib/index.js` 的错误分类器：

```js
function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  ...
}
```

`dsh-client-ui-chat` 再把 `AUTH` 渲染成界面文案：

```js
"message.failure.auth": "API 密钥无效"
```

注意它是**对错误文本做正则**，不解析 HTTP 状态码，也不区分子错误类型。
AgentRouter 返回的 `401 unauthorized client detected` 明明是在说「客户端不认识」，
被归类成 `AUTH` 之后就变成了「密钥无效」。

**所以第一条纪律：永远先看原始报错，不要信 UI 文案。**

### 怎么拿到原始报错

会话日志是 zstd 压缩的，而且**是多帧拼接**（一个文件里几十上百个独立 zstd frame）。
`zlib.zstdDecompressSync` 只解第一帧，直接解会得到几百字节的垃圾。必须按 magic number
`28 B5 2F FD` 切帧逐个解：

```powershell
$s = Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -File -Filter *.zstd |
     Sort-Object LastWriteTime -Descending | Select-Object -First 1
node -e "
const zlib=require('zlib'),fs=require('fs');
const buf=fs.readFileSync(process.argv[1]);
let offs=[];
for(let i=0;i<=buf.length-4;i++){
  if(buf[i]===0x28&&buf[i+1]===0xb5&&buf[i+2]===0x2f&&buf[i+3]===0xfd) offs.push(i);
}
const chunks=[];
for(let k=0;k<offs.length;k++){
  const s=offs[k], e=(k+1<offs.length)?offs[k+1]:buf.length;
  try{ chunks.push(zlib.zstdDecompressSync(buf.subarray(s,e))); }catch(e){}
}
fs.writeFileSync(process.argv[2], Buffer.concat(chunks));
console.log('frames', offs.length);
" $s.FullName "$env:TEMP\session.jsonl"
```

然后：

```powershell
Select-String -Path "$env:TEMP\session.jsonl" -Pattern '401|403|failure'
```

本次就是靠这一步挖出了真正的报错体：

```json
{"kind":"error","error":{
  "message":"401: {\"message\":\"unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB\"}",
  "code":"AUTH"}}
```

---

## 2. 故障时间线

### 第 1 轮 —— 客户端指纹

**现象**：选 AgentRouter 模型发消息，整轮失败，提示「API 密钥无效」。

**排查路径**：

1. 先怀疑配置。读 `settings.yaml`：provider/baseURL/model 都符合
   [AgentRouter 官方文档](https://agentrouter.org/docs/)（OpenAI 兼容必须以 `/v1` 结尾）。
2. 解压会话日志，拿到 `401 unauthorized client detected` —— **不是**「invalid api key」。
   AgentRouter 根本没在说密钥有问题。
3. 做对照实验：固定其它变量，只改 `User-Agent`。

**实测矩阵**（`POST https://agentrouter.org/v1/chat/completions`）：

| `User-Agent` | 结果 |
|---|---|
| `deepseek-harness/0.1.5-rc.2 (+https://github.com/...)`（DSH 发的） | 401 |
| `dsh/0.1.5`、`curl/8.4.0`、`OpenAI/NodeJS/4.0.0`、`Mozilla/5.0` | 401 |
| `claude-cli`、`claude-cli/1.0.0`、`claude-cli/2.1.251` | 401 |
| `claude-cli/1.0.60 (external, cli)` | **200** |
| `claude-cli/2.1.251 (external, cli)` | **200** |

结论：放行的是 `claude-cli/<x.y.z> (external, cli)` —— **` (external, cli)` 后缀不能少**。
OpenAI 兼容端点和 Anthropic 兼容端点（`/v1/messages`）卡的是同一道门。

**为什么改配置解决不了**：

- `dsh-llm-pi-ai` 恒发自己的归属 UA（`attributionHeaders()`）。
- `requestHeaders()` 会**丢掉**所有与归属头同名的 `headers` 配置项，而 `user-agent` 恰好是
  唯一的保留名 —— 写在 provider 上的 `headers: {User-Agent: ...}` 会被静默忽略。
- pi-ai 的 `mergeClientHeaders()` 让请求级 `options.headers` 覆盖一切，连它自己那个
  `claude-cli/2.1.251`（只在 OAuth 分支用）也会被 DSH 的值盖掉。

**修复**：在 `globalThis.fetch` 层改写 —— 见下面第 5 节。

---

### 第 2 轮 —— `developer` 角色

**现象**：UA 修好后，报错换了内容（这本身就是「第 1 轮已生效」的证据）：

```
400: messages[0].role: unknown variant `developer`,
     expected one of `system`, `user`, `assistant`, `tool`, `latest_reminder`
```

**排查路径**：`expected one of ... latest_reminder` 里的变体列表暴露了上游身份 ——
这是 **DeepSeek 原生后端**。AgentRouter 把 `deepseek-*` 转发过去，它虽然 OpenAI 兼容，
但角色集合更窄。

**根因**：pi-ai 对「推理模型」会把系统提示词发成 OpenAI 的 `developer` 角色
（`openai-completions.js:910`）：

```js
const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
const role = useDeveloperRole ? "developer" : "system";
```

`supportsDeveloperRole` 默认按 baseURL 自动探测，`agentrouter.org` 被当成普通 OpenAI 端点
→ 发 `developer`。而我们的模型声明了 `reasoningEfforts`，`model.reasoning` 为真。

**修复**（纯配置，在 `settings.yaml` 的 provider 下）：

```yaml
compat:
  supportsDeveloperRole: false   # 保持 system
```

**顺手把其余字段全探了一遍**，确认只有角色这一项有问题：

| 探测项 | 结果 |
|---|---|
| `role=developer` / `role=system` | 400 / **200** |
| `max_tokens` / `max_completion_tokens` | 都 200 |
| `reasoning_effort: low/high/max/medium/minimal/none` | 全部 200 |
| `stream` + `stream_options.include_usage` | 200 |
| `tools` + `strict: true` | 200 |
| tool result 带 / 不带 `name` | 都 200 |
| `image_url` 部件 | 200 |
| `max_tokens: 384000` | 200 |

**一个需要知道的约束**：思考模式下，回放的 assistant 消息必须带回**非空**
`reasoning_content`，否则：

```
400: The `reasoning_content` in the thinking mode must be passed back to the API.
```

- 空字符串 `""` **也不行**。
- pi-ai 天然满足：它把响应里的字段名存成 thinking block 的 signature
  （`openai-completions.js:428`），DSH 再持久化成
  `replayState.blocks[].thinkingSignature`，回放时写回原文。
- **没有 compat 开关能合成它** —— `requiresReasoningContentOnAssistantMessages: true`
  只会填一个空串，反而同样被拒。所以不要开它。
- 只有「历史来自别的 provider、没有本渠道 signature」时才可能缺，那种情况开新会话。

---

### 第 3 轮 —— 换国内镜像，插件失灵

**现象**：`baseURL` 改成 `https://ps.air-outer.com/v1` 后，又出现「API 密钥无效」。

**先查环境**：

```
ps.air-outer.com      → CNAME → 阿里云 ALB（新加坡），可达
agentrouter.org       → 162.125.80.6（Facebook 的 IP 段！）→ 连接超时
```

`agentrouter.org` 在国内 DNS 被污染、直连超时 —— 换镜像是合理操作。

**对照实验**（`tools/client-identity-matrix.mjs`）：两个域名返回**完全相同**的
`unauthorized client detected` 文案、**相同**的 `discord.gg/HgekCyHJqB` 支持链接、
**相同**的模型列表 → 确认是同一个网关，指纹校验一致。

| `User-Agent` | `ps.air-outer.com` |
|---|---|
| `deepseek-harness/...` | 401 |
| `claude-cli/2.1.251 (external, cli)` | **200** |

**根因是我自己的 bug**。上一版插件的判定写成：

```js
const targeted = url === undefined ? als.getStore() !== undefined : isAgentRouterUrl(url);
```

URL 只要读得出来（真实请求永远能读出来），就**只看域名白名单，路由作用域被完全绕过**。
而白名单里只有 `agentrouter.org`。后果：把 `baseURL` 指到任何别的域名，插件都会静默失效，
但 provider 看起来配置得好好的。

**修复**：改成主次分明 —— **路由作用域是主要依据，域名白名单降级为兜底**：

```js
const targeted = als.getStore() !== undefined
  || (url !== undefined && isAgentRouterUrl(url, hosts));
```

理由：走 `llm/stream` 的模型请求本来就属于已配置的 provider 路由，指向哪个域名都该改写；
`hosts` 只负责不走 `llm/stream` 的调用（主要是设置页的「获取模型列表」），并且现在可配置。

**结果**：以后再换镜像，模型请求自动生效，无需改任何东西。

---

## 3. 三个根因的共性

三次都不是「密钥问题」，但三次都显示同一句话。区别只在**在哪一层被拒**：

```
DNS 污染        → 连接超时（agentrouter.org 在国内）
  └─ 客户端指纹 → 401 unauthorized client detected   ← 第 1、3 轮
       └─ 请求体 → 400 unknown variant 'developer'   ← 第 2 轮
            └─ 额度 → 402 Budget pool quota exhausted
                 └─ 内容审核 → 400 content-blocked
```

排查时按这个顺序自下而上定位，不要跳步。

---

## 4. 可复用的排查方法论

1. **拿原始报错，不信 UI 文案。** UI 的分类器可能只是对文本做正则。
2. **对照实验，一次只改一个变量。** 本案例中「只改 UA」直接锁定了答案。
3. **用真实 SDK 做端到端。** pi-ai 走的是 `openai` SDK，所以 `e2e.mjs` 就用
   `new OpenAI({ baseURL, apiKey, fetch: undefined })` —— 精确复刻适配器的构造方式，
   而不是手搓一个 fetch（手搓的通过了也不代表 DSH 能通过）。
4. **从源码确认，不靠推测。** 例：`grep -n "supportsDeveloperRole" pi-ai/.../openai-completions.js`
   直接看到 `role = useDeveloperRole ? "developer" : "system"`，比试错快得多。
5. **探针留在仓库里。** 每个结论都要能一条命令复现，否则下次只能重推。
6. **端到端失败时，先确认「补丁到底有没有被调用」。** 第 3 轮的教训：插件没生效，
   但表面上一切正常。所以判定逻辑要有单测锁死。

---

## 5. 修复方案总览

### 5.1 插件（负责 UA）

位置：本仓库，即 `dsh-provider-client-identity`。安装与配置见 [README.zh.md](../README.zh.md)。
本节记录的是它当初针对 AgentRouter 的设计，后来泛化成了通用插件（AgentRouter 变成内置预设）。

它挂在 `globalThis.fetch` 上（pi-ai 请求栈唯一够得着的缝隙），两条判定：

| 判定 | 作用 |
|---|---|
| `llm/stream` 的 AsyncLocalStorage store（**主要**） | 属于已配置 provider 路由的请求，不管指向哪个域名都改写 |
| `hosts` 域名白名单（**兜底**） | 覆盖不走 `llm/stream` 的调用，主要是 `GET /v1/models` |

改写内容：`user-agent: claude-cli/2.1.251 (external, cli)`。
补丁是 fiber 作用域的 `ctx.effect`，插件停用/更新即还原。

设计参照仓库内的 `dsh-opencode-session`（同样在 fetch 层加 `x-opencode-session`）。

### 5.2 配置（负责请求体）

`~/.dsh/settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    agentrouter:
      displayName: AgentRouter
      apiKeyEnv: AGENTROUTER_API_KEY
      api: openai-completions
      baseURL: https://ps.air-outer.com/v1     # 国内镜像；直连可用时换回 agentrouter.org
      compat:
        supportsDeveloperRole: false            # 上游只认 system
      models:
        - id: deepseek-v4-flash
          name: deepseek-v4-flash
          contextWindow: 1000000
          maxTokens: 384000
          input: [text, image]
          reasoningEfforts: { low: low, high: high, max: max }
      transport: auto
```

---

## 6. 快速诊断手册

### 症状 → 命令 → 判读

| 症状 | 先跑 | 判读 |
|---|---|---|
| 提示「API 密钥无效」 | 解压会话日志搜 `401\|403` | 看到 `unauthorized client detected` → 是 UA/指纹问题，不是密钥 |
| 同上，且刚换了镜像 | `node tools/client-identity-matrix.mjs <key>` | 新域名是不是同一个网关；`claude-cli` UA 是否为 200 |
| `400 unknown variant 'developer'` | 检查 `settings.yaml` | `compat.supportsDeveloperRole` 是否为 `false` |
| `400 reasoning_content ... must be passed back` | — | 历史来自别的 provider，开新会话 |
| `402 Budget pool quota` | `node gateway-audit.mjs <key>` | 该模型额度池耗尽，换 `deepseek-v4-flash` |
| `400 content-blocked` | — | 高度重复的内容触发审核，换成正常文本 |
| `503 无可用渠道` | `node gateway-audit.mjs <key>` | 模型 id 不在你的可用列表里 |
| 连接超时 | `Resolve-DnsName agentrouter.org` | 解析到无关 IP（如 162.125.x.x）= DNS 污染，换镜像 |

### 一条命令全量体检

```bash
cd dsh-provider-client-identity

npm test                                  # 插件逻辑 18 项单测，先确认自己没坏
node tools/client-identity-matrix.mjs <key>   # 各域名的 UA 对照矩阵
node tools/gateway-audit.mjs <key>            # 模型可用性 / 上限 / 模态 / 审核 / 长上下文
node tools/payload-probe.mjs <key>            # 请求体各字段接受度
node tools/e2e.mjs <key> [baseURL]            # 走真实 openai SDK 的端到端
```

密钥可用 `AGENTROUTER_API_KEY` 环境变量传入，避免留在命令历史里。

---

## 7. 已核实的事实清单

供以后对照，「网关行为变了没有」。

**客户端指纹**
- 放行：`claude-cli/<x.y.z> (external, cli)`
- 拒绝：其它一切，包括 `claude-cli/<x.y.z>`（无 ` (external, cli)` 后缀）
- OpenAI 与 Anthropic 两个端点同样对待

**请求体**
- 只认 `system` / `user` / `assistant` / `tool`（`latest_reminder` 为上游内部变体）
- 思考模式下回放的 assistant 必须带**非空** `reasoning_content`
- `reasoning_effort` 全档位接受；`max_tokens` 与 `max_completion_tokens` 都接受

**账号能力**
- 可用模型只有 `deepseek-v4-flash`（OpenAI / Anthropic 双协议）
- `/v1/models` 另外挂出 4 个模型（`claude-opus-4-8`、`claude-opus-5`、`gpt-5.6-sol`、
  `gpt-6-astra`），但调用一律 `402 Budget pool quota has been exhausted`

**容量实测**
- 上下文：在 ~30 万 token 的 prompt **开头**放暗号，模型能准确回忆 → 至少 30 万为真（非截断）
- 输出上限：384000 接受
- 图片：接受
- 审核：只针对高度重复内容（~2.7k token 重复文本被拒，等长正常文本通过）

---

## 8. 文件索引

本仓库：

```
dsh-provider-client-identity/
├─ index.js                        # 插件本体：作用域化的 fetch 改写
├─ cordis.patch.yml                # bundle：插入装载行（预填 AgentRouter 预设）
├─ test.mjs                        # 18 项单测（含第 3 轮的回归用例）
├─ tools/
│  ├─ e2e.mjs                      # 真实 openai SDK 端到端
│  ├─ client-identity-matrix.mjs   # 多域名 UA 对照矩阵
│  ├─ payload-probe.mjs            # 请求体字段接受度
│  └─ gateway-audit.mjs            # 账号与网关能力体检
├─ docs/agentrouter.zh.md          # 本文档
└─ README.zh.md / README.md        # 安装与配置
```

部署侧：

```
~/.dsh/
├─ settings.yaml                   # provider 配置 + compat
└─ profiles/web/cordis.patch.yml   # 若手动安装：加载插件、hosts/providers 配置
```

会话日志（原始报错在这里）：

```
~/.dsh/sessions/<工作目录转义>/session-<id>/session.v3.jsonl.zstd
```

---

## 9. 经验教训

1. **UI 的错误分类器会张冠李戴。** `AUTH` 是对错误文本做正则得来的，不等于认证失败。
   报错链路里最靠近真相的是 HTTP 响应体。
2. **「保留名 header」是隐形陷阱。** DSH 有意不让 provider 覆盖归属 UA，所以这类需求
   只能落在插件层 —— 但这也意味着任何绕过 UI 直接改 baseURL 的操作都可能静默失效。
3. **作用域判定必须主次分明。** 兜底规则不能反过来否决主规则。第 3 轮就是这个错误，
   而且它的失败是**静默**的（provider 看起来正常）。凡是「配置对了但不生效」，
   优先怀疑判定逻辑的顺序。
4. **每个结论都要有可复现的探针。** 本次三个根因定位都依赖对照实验，而不是读文档猜。
5. **改完要端到端验，不要只看单测。** 单测证明「函数对」，端到端证明「链路通」。
6. **镜像域名是易变的外部依赖。** 现在换域名不用改代码（路由作用域生效），
   只有「获取模型列表」需要把新域名加进 `hosts`。
