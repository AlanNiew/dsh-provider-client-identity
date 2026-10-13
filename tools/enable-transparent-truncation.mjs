#!/usr/bin/env node
/**
 * Hand a truncated upstream stream straight to the host instead of letting
 * billion-context's acp-proxy turn it into an in-band error.
 *
 * Why: the AgentRouter gateway routinely closes the SSE stream without a
 * finish_reason *and* without a terminal marker. billion-context's
 * `emitUpstreamTruncation()` then injects
 *     {error:{type:"server_error",code:"upstream_stream_truncated",...}}
 * and DSH's pi-ai adapter classifies that as TRANSPORT and retries the whole
 * attempt. The turn still succeeds on a later attempt, so the user-visible
 * symptom is not failure but slowness: roughly a third of the attempts are
 * thrown away and re-generated.
 *
 * The proxy already implements the alternative — pass the raw bytes through and
 * let the host own truncation handling (upstream #2563) — but the lane
 * allow-list is hard-coded to the `pi` client:
 *
 *     var TRANSPARENT_TRUNCATION_AGENTS=new Set(["pi"]);
 *
 * DSH identifies itself as `x-bili-plugin: dsh` (billion-context
 * `dist/agent/dsh-native.js`), so it never qualifies and keeps taking the
 * error path. This flips the allow-list to ["pi","dsh"].
 *
 * Pair it with `compat.supportsFinishReason: false` on the provider row.
 * Without that, pi-ai throws "Stream ended without finish_reason" on the
 * now-unterminated stream and the retry comes straight back.
 *
 * Trade-off: when the gateway really did cut a response short, the turn is now
 * accepted as complete rather than re-run. That is the speed/correctness call
 * this script exists to make explicit.
 *
 * Usage:
 *   node tools/enable-transparent-truncation.mjs [profileDir] [--revert]
 *
 * profileDir defaults to %USERPROFILE%/.dsh/profiles/desktop.
 *
 * billion-context is an ordinary npm dependency, so reinstalling or upgrading
 * it restores the unpatched file — re-run this script afterwards. A one-time
 * `${dist}.orig` backup is written next to it.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PATCHED = 'TRANSPARENT_TRUNCATION_AGENTS=new Set(["pi","dsh"])'
const ORIGINAL = 'TRANSPARENT_TRUNCATION_AGENTS=new Set(["pi"])'

const args = process.argv.slice(2)
const revert = args.includes('--revert')
const profileDir = args.find((a) => !a.startsWith('--')) ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const dist = join(profileDir, 'node_modules', 'billion-context', 'dist', 'index.js')

const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)

let size
try {
  size = statSync(dist).size
} catch {
  console.error(`billion-context not found at ${dist}`)
  console.error('pass the profile directory explicitly if the profile lives elsewhere')
  process.exit(2)
}

const before = hash(dist)
let src = readFileSync(dist, 'utf8')
const from = revert ? PATCHED : ORIGINAL
const to = revert ? ORIGINAL : PATCHED

if (src.includes(to) && !src.includes(from)) {
  console.log(`already ${revert ? 'reverted' : 'patched'} — nothing to do`)
  console.log(`  ${dist}`)
  console.log(`  ${size} bytes  sha256:${before}`)
  process.exit(0)
}

const hits = src.split(from).length - 1
if (hits !== 1) {
  console.error(`expected exactly 1 occurrence of:\n  ${from}\nfound ${hits}`)
  console.error('refusing to patch — the billion-context version probably changed')
  process.exit(3)
}

const backup = `${dist}.orig`
try {
  statSync(backup)
} catch {
  copyFileSync(dist, backup)
  console.log(`backup written: ${backup}`)
}

src = src.replace(from, to)
if (!src.includes(to) || src.includes(from)) {
  console.error('replacement did not take effect — nothing written')
  process.exit(4)
}
writeFileSync(dist, src)

console.log(`${revert ? 'reverted' : 'patched'}: ${dist}`)
console.log(`  sha256:${before} -> sha256:${hash(dist)}`)
console.log(`  ${size} -> ${statSync(dist).size} bytes`)
console.log('')
console.log('restart the DSH app for this to take effect (the module is loaded at boot).')
