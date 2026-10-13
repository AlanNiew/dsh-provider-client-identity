#!/usr/bin/env node
/**
 * Retry report: how much of each provider's work is discarded and re-generated.
 *
 * A retry is not a failure — the turn usually completes on a later attempt — so
 * the visible symptom is a model that works but feels slow. This is the meter
 * for that. The failure-message census at the bottom is the important half: it
 * identifies *which* layer raised the error. pi-ai's own
 * `Stream ended without finish_reason` and the bundled proxy's
 * `upstream stream ended before a completion event` are different bugs with
 * different fixes, and only the message text tells them apart. See
 * docs/agentrouter.md, "Failure 4".
 *
 * Usage:
 *   node tools/retry-report.mjs [options]
 *
 *   --sessions <dir>   session log root (default ~/.dsh/sessions)
 *   --provider <name>  only this provider
 *   --since <iso>      ignore records before this instant
 *   --split <iso>      report twice, before and after this instant
 *   --json             machine-readable output
 *
 * Session logs are multi-frame zstd: one `zstdDecompressSync` returns only the
 * first frame, so the file is split on the frame magic `28 B5 2F FD` first.
 * "Attempts" is retries + completed steps — the closest thing the log records
 * to "how many times this provider was asked to produce something". Read the
 * ratio, not the raw retry count: a busy provider with a big denominator is
 * healthier than a quiet one with a small one.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const root = flag('sessions', join(homedir(), '.dsh', 'sessions'))
const only = flag('provider', null)
const sinceArg = flag('since', null)
const splitArg = flag('split', null)
const since = sinceArg ? Date.parse(sinceArg) : null
const splitAt = splitArg ? Date.parse(splitArg) : null
const asJson = has('json')

const stamp = (ms) => new Date(ms).toLocaleString('sv-SE')

/** Multi-frame zstd: decompress every frame, in order. */
function readFrames(buf) {
  const offsets = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
  }
  const parts = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], end)))
    } catch {
      /* a torn trailing frame is normal in a live log */
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

const logs = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.startsWith('session.') && entry.name.includes('jsonl')) logs.push(p)
  }
}
try {
  walk(root)
} catch {
  console.error(`no session logs under ${root}`)
  process.exit(2)
}
logs.sort()

const records = []
let unreadable = 0

for (const fp of logs) {
  let text
  try {
    text = readFrames(readFileSync(fp))
  } catch {
    unreadable++
    continue
  }

  const parsed = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      parsed.push(JSON.parse(line))
    } catch {
      /* skip malformed line */
    }
  }

  // Which provider did each turn belong to? `llm/retry` and `request/header`
  // both carry it; when a log mentions exactly one provider, that is the
  // fallback for records that carry none.
  const turnProvider = {}
  for (const r of parsed) {
    const d = r.data ?? {}
    if (r.type === 'request/header' && d.header?.config?.provider && d.turn !== undefined) {
      turnProvider[d.turn] = d.header.config.provider
    }
    if (String(r.type ?? '').includes('retry') && d.provider && d.turn !== undefined) {
      turnProvider[d.turn] ??= d.provider
    }
  }
  const mentioned = new Set(Object.values(turnProvider))
  const sole = mentioned.size === 1 ? [...mentioned][0] : null

  for (const r of parsed) {
    const type = String(r.type ?? '')
    if (type !== 'llm/retry' && type !== 'assistant/message') continue
    const d = r.data ?? {}
    const ms = typeof r.time === 'number' ? r.time : Date.parse(r.time)
    if (!Number.isFinite(ms)) continue
    if (since && ms < since) continue
    const provider = d.provider ?? turnProvider[d.turn] ?? sole ?? 'unknown'
    if (only && provider !== only) continue
    records.push({
      ms,
      provider,
      retry: type === 'llm/retry',
      code: d.failure?.code ?? null,
      message: d.failure?.message ?? null,
    })
  }
}

if (!records.length) {
  console.log(`no retry or step records found in ${logs.length} session logs`)
  process.exit(0)
}

function tally(rows) {
  const byProvider = new Map()
  const byMessage = new Map()
  for (const r of rows) {
    const p = byProvider.get(r.provider) ?? { retries: 0, steps: 0, codes: new Map(), first: Infinity, last: -Infinity }
    if (r.retry) {
      p.retries++
      if (r.code) p.codes.set(r.code, (p.codes.get(r.code) ?? 0) + 1)
      if (r.message) byMessage.set(r.message, (byMessage.get(r.message) ?? 0) + 1)
    } else {
      p.steps++
    }
    if (r.ms < p.first) p.first = r.ms
    if (r.ms > p.last) p.last = r.ms
    byProvider.set(r.provider, p)
  }
  return { byProvider, byMessage }
}

function report(title, rows) {
  const { byProvider, byMessage } = tally(rows)
  console.log(`\n=== ${title} ===`)
  if (!byProvider.size) {
    console.log('  (nothing in this window)')
    return
  }
  let retries = 0
  let steps = 0
  const ordered = [...byProvider].sort((a, b) => b[1].retries - a[1].retries || a[0].localeCompare(b[0]))
  for (const [provider, s] of ordered) {
    const attempts = s.retries + s.steps
    retries += s.retries
    steps += s.steps
    const rate = attempts ? `${((s.retries / attempts) * 100).toFixed(1)}%` : '—'
    const codes = [...s.codes].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' ')
    console.log(
      `  ${provider.padEnd(18)}${String(s.retries).padStart(5)} retries / ${String(attempts).padStart(5)} attempts  =  ${rate.padStart(6)}` +
        `   ${codes.padEnd(24)} ${s.first === Infinity ? '' : `[${stamp(s.first)} ~ ${stamp(s.last)}]`}`,
    )
  }
  const attempts = retries + steps
  console.log(
    `  ${'TOTAL'.padEnd(18)}${String(retries).padStart(5)} retries / ${String(attempts).padStart(5)} attempts  =  ` +
      `${(attempts ? `${((retries / attempts) * 100).toFixed(1)}%` : '—').padStart(6)}`,
  )
  if (byMessage.size) {
    console.log('\n  failure messages — the thrower tells you which bug this is:')
    for (const [message, n] of [...byMessage].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${String(n).padStart(5)}  ${message}`)
    }
  }
}

const windows = splitAt
  ? [
      [`before ${stamp(splitAt)}`, records.filter((r) => r.ms < splitAt)],
      [`after ${stamp(splitAt)}`, records.filter((r) => r.ms >= splitAt)],
    ]
  : [['all sessions', records]]

if (asJson) {
  console.log(
    JSON.stringify(
      {
        sessions: logs.length,
        unreadable,
        records: records.length,
        groups: windows.map(([title, rows]) => {
          const { byProvider, byMessage } = tally(rows)
          return {
            title,
            providers: [...byProvider].map(([provider, s]) => ({
              provider,
              retries: s.retries,
              steps: s.steps,
              codes: Object.fromEntries(s.codes),
            })),
            messages: Object.fromEntries(byMessage),
          }
        }),
      },
      null,
      2,
    ),
  )
} else {
  let first = Infinity
  let last = -Infinity
  for (const r of records) {
    if (r.ms < first) first = r.ms
    if (r.ms > last) last = r.ms
  }
  console.log(
    `sessions: ${logs.length} logs${unreadable ? ` (${unreadable} unreadable)` : ''}, ` +
      `${records.length} retry/step records, window ${stamp(first)} ~ ${stamp(last)}`,
  )
  for (const [title, rows] of windows) report(title, rows)
}
