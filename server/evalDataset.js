// Replays the dataset through the rules and compares against the scenario labels.
// Usage: npm run rules:eval -- <events.csv> <labels.csv>
import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { fromCsvRow } from './datasetMap.js'
import { replayEvents } from './replay.js'

const [eventsPath, labelsPath] = process.argv.slice(2)
if (!eventsPath || !labelsPath) {
  console.log('Usage: npm run rules:eval -- <events.csv> <labels.csv>')
  process.exit(1)
}

const read = (p) => parse(fs.readFileSync(p, 'utf8'), { columns: true, skip_empty_lines: true })
const rows = read(eventsPath)
const labels = read(labelsPath)
const labelBySession = Object.fromEntries(labels.map((l) => [l.session_ref, l.scenario_label]))

const events = rows.map(fromCsvRow)
const alerts = replayEvents(events)

const sessionOfUser = new Map()
for (const r of rows) sessionOfUser.set(r.session_ref, r.user_ref)

// which sessions raised which rules
const bySession = {}
for (const a of alerts) {
  const s = a.session_ref
  ;(bySession[s] ||= new Set()).add(a.rule_id)
}

const scenarios = {}
for (const s of new Set(rows.map((r) => r.session_ref))) {
  const sc = labelBySession[s] || 'benign'
  ;(scenarios[sc] ||= { sessions: 0, flagged: 0, rules: {} })
  scenarios[sc].sessions++
  if (bySession[s]) {
    scenarios[sc].flagged++
    for (const r of bySession[s]) scenarios[sc].rules[r] = (scenarios[sc].rules[r] || 0) + 1
  }
}

console.log(`\nEvents: ${rows.length}   Alerts raised: ${alerts.length}\n`)
console.log('scenario'.padEnd(32), 'sessions'.padStart(8), 'flagged'.padStart(8), '  rules fired')
for (const [sc, v] of Object.entries(scenarios).sort()) {
  const rules = Object.entries(v.rules).map(([k, n]) => `${k}x${n}`).join(' ')
  console.log(sc.padEnd(32), String(v.sessions).padStart(8), String(v.flagged).padStart(8), ' ', rules)
}
const byRule = {}
for (const a of alerts) byRule[a.rule_id] = (byRule[a.rule_id] || 0) + 1
console.log('\nAlerts by rule:', byRule)
