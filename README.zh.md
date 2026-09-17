# dsh-provider-client-identity

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 宿主插件：让某个 provider 路由
**以网关期望的客户端身份发请求**。

它存在的原因：有些网关在检查密钥之前先做**客户端指纹识别**，不认识的客户端一律回 401。而 Harness
会把这种失败显示成 **「API 密钥无效」** —— 密钥根本没被看过，却让你去查密钥，有时一查就是几小时。

> ### ⚠️ 先读这段
>
> 本插件通过**伪造客户端身份**来绕过厂商的客户端校验。它是作为「互操作性 shim」发布的，面向的是
> 已经有合法账号、只是被客户端指纹挡住（而非被策略挡住）的人。
>
> - 这样做**可能违反服务商的服务条款**。
> - 你的账号可能被限流或封禁。
> - 它天然脆弱：厂商随时可以加强指纹校验，届时即刻失效。
>
> 使用后果自负。如果服务商提供了官方途径让你使用自己的客户端，请优先用官方途径。

---

## 问题是什么

AgentRouter 用户在 Harness 里看到的是这行提示，而它是错的：

```
本轮运行失败 · API 密钥无效
```

会话日志里的原始失败长这样：

```json
{"kind":"error","error":{
  "message":"401: {\"message\":\"unauthorized client detected, contact support for assistance at ...\"}",
  "code":"AUTH"}}
```

两件事叠加造成了误导：

1. **`dsh-llm-pi-ai` 是拿错误*文本*猜失败类型的。**
   `classifyPiAiError()` 只要在消息里看到 `401`/`403` 就返回 `AUTH`，UI 再把 `AUTH` 渲染成
   「API 密钥无效」。它完全不看响应体到底在说什么。
2. **真正的门禁是 `User-Agent`。** 对 `https://agentrouter.org/v1/chat/completions` 和
   `/v1/messages` 实测：

   | `User-Agent` | 结果 |
   | --- | --- |
   | `deepseek-harness/<ver> (+url)` ← DSH 发的 | `401 unauthorized client detected` |
   | `curl/8.4.0`、`OpenAI/NodeJS/4.0.0`、`Mozilla/5.0` | `401 unauthorized client detected` |
   | `claude-cli`、`claude-cli/1.0.0`、`claude-cli/2.1.251` | `401 unauthorized client detected` |
   | `claude-cli/1.0.60 (external, cli)` | **`200`** |
   | `claude-cli/2.1.251 (external, cli)` | **`200`** |

   放行的格式是 `claude-cli/<x.y.z> (external, cli)`。**` (external, cli)` 后缀不能少** ——
   去掉后缀的同一串会被拒。

**只改 `User-Agent`，同一个密钥立刻就通。** 密钥从来不是问题。

## 为什么必须用插件

这事配置不掉，而且从文档里看不出来：

- Harness 恒发自己的归属 `User-Agent`（`deepseek-harness/<版本> (+url)`），由 `attributionHeaders()` 生成。
- `dsh-llm-pi-ai` 的 `requestHeaders()` 会**丢掉**所有与归属头同名的 `headers` 配置项，而
  `user-agent` 恰好是唯一的归属头。写在 provider 上的 `headers: {User-Agent: ...}` 会被静默忽略。
- pi-ai 的 `mergeClientHeaders()` 让请求级 header 优先，所以连 pi-ai 自己那个 Claude Code 形状的
  `User-Agent`（只在 OAuth 分支用）也会被覆盖掉。

唯一够得着的缝隙是 pi-ai 请求栈底下的进程级 `globalThis.fetch` —— 插件就挂在那里。仓库内的
`dsh-opencode-session` 插件用的是同一招（加 `x-opencode-session`）。

> 只有 `user-agent` 需要插件。普通的自定义 header 不与归属名冲突，写在 `settings.yaml` 的
> provider `headers` 里即可。

## 安装

尚未发布到 npm，直接从仓库安装：

```bash
dsh plugin --profile web add github:AlanNiew/dsh-provider-client-identity
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，然后**自行重整 layer 栈**：因为包声明了 `dsh.bundle`，
它会自动被加进 `dsh.profile.bundles`，其 patch 再插入装载行并预填 AgentRouter 预设。
装完**需要重启 Harness** —— 插件模块有缓存，仅靠 patch 热重载不会重新导入。

将来发布到 npm 后，`dsh plugin --profile web add dsh-provider-client-identity` 效果完全相同。

<details>
<summary>手动安装（不用 bundle、不用 pnpm）</summary>

在 profile 的 `cordis.patch.yml` 里直接引用入口文件。加载器会把相对路径转成以 patch 文件为基准的
`file://` URL：

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

> 两种安装方式**不要混用**。两者用的都是同一个装载行 id `provider-client-identity`，
> profile 里同时存在手动行和已安装的 bundle 会因 **duplicate loader entry id** 启动失败。
> 从手动安装迁移时，先删掉手动行再装包。

## 配置

每个字段都可选；**省略**的字段回落到 AgentRouter 预设。显式给出的列表会**原样采用 ——
包括空列表**，所以 `hosts: []` 表示"不做域名兜底"，而不是悄悄恢复预设。
要彻底关掉插件，在它的装载行上设 `disabled: true`。

```yaml
- id: provider-client-identity
  name: dsh-provider-client-identity
  config:
    providers: [agentrouter]                                   # 作用到的路由 key
    hosts: [agentrouter.org, ps.air-outer.com]                 # 覆盖不走 llm/stream 的调用
    userAgent: "claude-cli/2.1.251 (external, cli)"            # 要呈现的身份
```

| 字段 | 含义 |
| --- | --- |
| `providers` | 作用到的 provider 路由 key（即 `llm-pi-ai.providers` 字典的键）。**这是主要判定依据。** |
| `hosts` | 给不走 `llm/stream` 的调用兜底，主要是设置页的模型发现（`GET /v1/models`）。**配置它会替换默认值**，需要的域名要全部列出。 |
| `userAgent` | 要呈现的 `User-Agent`。 |

### 用在别的网关上

1. 先跑 `node tools/client-identity-matrix.mjs <key> <host>`，确认该网关确实在做客户端指纹，并找出它接受哪个 `User-Agent`。
2. 把 `providers` 指向你的路由 key，`hosts` 指向它的域名，`userAgent` 指向被接受的值。

注意：**换路由的 `baseURL` 不需要改这里** —— 路由作用域是主要依据，所以换镜像自动生效。
只有 `hosts`（也就是模型发现）跟域名相关。

## AgentRouter 预设还需要改一处配置

客户端身份只是第一道门。AgentRouter 把 `deepseek-*` 转发到 DeepSeek 原生后端，它虽然 OpenAI
兼容但更窄：不认识 OpenAI 的 `developer` 角色。pi-ai 对推理模型会发 `developer`，于是请求死在：

```
400: messages[0].role: unknown variant `developer`, expected one of
     `system`, `user`, `assistant`, `tool`, `latest_reminder`
```

在 provider 配置里修掉：

```yaml
llm-pi-ai:
  providers:
    agentrouter:
      baseURL: https://ps.air-outer.com/v1   # 或 https://agentrouter.org/v1
      compat:
        supportsDeveloperRole: false         # 保持 system
```

完整配置、以及其余请求体字段的实测结论，见 [docs/agentrouter.zh.md](./docs/agentrouter.zh.md)。

## 工作原理

| 步骤 | 说明 |
| --- | --- |
| 按路由作用域（**主要依据**） | `llm/stream` 监听器为配置的路由进入一个 `AsyncLocalStorage` store。在该 store 内驱动的请求**无论指向哪个域名**都会被改写。 |
| 按域名作用域（兜底） | fetch 补丁同时按 URL 匹配配置的域名，覆盖不走 `llm/stream` 的调用。 |
| 改写 | 对命中的请求**设置** `user-agent`。是「设置」而不是「缺失才填」—— Harness 的值永远在。 |
| 还原 | 补丁是 fiber 作用域的 `ctx.effect`；插件停用或卸载即还原 `globalThis.fetch`。 |

## 验证

```bash
npm test                                              # 18 项离线检查，不联网
node tools/client-identity-matrix.mjs <key>           # 网关要哪个身份？
node tools/payload-probe.mjs <key>                    # 它接受哪些请求体形状？
node tools/gateway-audit.mjs <key>                    # 模型 / 上限 / 模态 / 审核 / 上下文
node tools/e2e.mjs <key>                              # 走真实 OpenAI 客户端的端到端
```

密钥从 `AGENTROUTER_API_KEY` 环境变量或 `argv` 读取。每个工具都接受可选的 base URL，可对任意网关使用。

## 排错

| 症状 | 可能原因 | 怎么办 |
| --- | --- | --- |
| 「API 密钥无效」/ `AUTH` | 任何 401/403，包括客户端指纹被拒 | 先解出会话日志里的原始失败，再动密钥 —— 见下 |
| `401 unauthorized client detected` | `User-Agent` 不被接受 | 跑 `tools/client-identity-matrix.mjs`，改 `userAgent` |
| 改了 `baseURL` 后立刻失效 | 用的是本插件早期版本，其域名检查覆盖了路由作用域 | 升级；现在路由作用域是主要依据（`test.mjs` 已锁死） |
| `400 unknown variant 'developer'` | 缺 `compat.supportsDeveloperRole: false` | 见上 |
| `400 reasoning_content ... must be passed back` | 思考模式下回放了没有 reasoning 的 assistant 轮次（典型是历史来自**别的** provider） | 开新会话 |
| 插件看起来没生效 | 插件模块有缓存，patch 热重载不会重新导入 | 重启 Harness |

**解出原始失败。** UI 只显示归类后的类型。真相在会话日志里，而它是**多帧 zstd** ——
一次 `zstdDecompressSync` 只解得出第一帧，必须按 magic number `28 B5 2F FD` 切帧：

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

## 局限

- **伪造是有意为之，且作用域很窄** —— 只改写属于配置的路由或域名的请求。
- **厂商随时能让它失效。** 如果 AgentRouter 从 `User-Agent` 扩展到别的 header，光改 `userAgent`
  不够，需要扩展插件。先用 `tools/client-identity-matrix.mjs` 确认。
- **域名是精确匹配。** 子域名不覆盖，需要显式列出。
- **补丁只能作用于「装好之后才构造」的客户端。** OpenAI SDK 是在**构造客户端时**绑定
  `globalThis.fetch`，而不是发请求时 —— `tools/e2e.mjs` 在打补丁前后各构造一个客户端，
  结果就是 401 / 200。插件在启动时装好，pi-ai 每次请求新构造的客户端都能拿到补丁；
  只有运行时才替换全局 fetch 的情况会漏掉。
- **报错仍会被错误归类。** 本插件修的是 `AUTH` 误判的其中一个成因，不是那个分类器本身。
  将来任何 401/403 依然会显示成「API 密钥无效」。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。与 AgentRouter、DeepSeek 均无隶属关系。
