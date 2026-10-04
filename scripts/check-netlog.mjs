#!/usr/bin/env node
// Fail when a Chromium net log shows a request that left the machine (#567).
//
// A manual verification tool for a packaged build, not part of the build or the test suite. Start
// the app on a scratch profile with a net log, use it, quit it, then check the log:
//
//   <app> --user-data-dir=<scratch dir> --log-net-log=<file>
//   node scripts/check-netlog.mjs <file> [<file>...]
//
// Use a scratch profile: without --user-data-dir the app opens the host's real profile. On Windows,
// also run once with `--lang=pl` (a language Windows cannot spell-check, so the spell checker would
// download a dictionary if it were on). Prints PASS / FAIL per log with every remote request and
// host lookup; the exit code is the number of failing logs. What counts as remote:
// scripts/lib/netlog-remote.mjs.
import { readFileSync } from 'node:fs'
import { parseNetLog, remoteRequests } from './lib/netlog-remote.mjs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/check-netlog.mjs <net-log.json> [<net-log.json>...]')
  process.exit(2)
}
let failed = 0
for (const file of files) {
  const { urls, hosts } = remoteRequests(parseNetLog(readFileSync(file, 'utf8')))
  const clean = Object.keys(urls).length === 0 && Object.keys(hosts).length === 0
  if (!clean) failed++
  console.log(`${clean ? 'PASS' : 'FAIL'}  ${file}`)
  for (const [url, n] of Object.entries(urls)) console.log(`      request x${n}  ${url}`)
  for (const [host, n] of Object.entries(hosts)) console.log(`      lookup  x${n}  ${host}`)
}
process.exit(failed)
