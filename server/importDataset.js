// Loads the big synthetic dataset into Postgres (lean columns only) and replays the rules over it,
// so the dashboard has data straight away.
// Usage: npm run db:import -- <events.csv> [--shift]
//   --shift  moves all timestamps so the newest event is "now" (so the dashboard ranges show it)
import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { pool } from './db.js'
import { fromCsvRow } from './datasetMap.js'
import { replayEvents } from './replay.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const shift = args.includes('--shift')
if (!file) {
  console.log('Usage: npm run db:import -- <events.csv> [--shift]')
  process.exit(1)
}

const COLS = [
  'event_time', 'event_category', 'user_ref', 'attempted_ref', 'session_ref', 'device_ref', 'device_trust_status',
  'login_result', 'login_failure_reason', 'otp_event_type', 'otp_verification_result', 'account_recovery_event',
  'document_action', 'document_type', 'document_ref', 'ownership_check_result', 'authorization_result',
  'response_action', 'response_reason', 'source',
]

try {
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true }).map(fromCsvRow)
  let delta = 0
  if (shift) {
    const newest = Math.max(...rows.map((r) => new Date(r.event_time).getTime()))
    delta = Date.now() - newest - 60000
  }
  const events = rows.map((r) => ({ ...r, event_time: new Date(new Date(r.event_time).getTime() + delta), source: 'dataset' }))

  await pool.query(`DELETE FROM events WHERE source='dataset'`)
  await pool.query(`DELETE FROM alerts WHERE source='dataset'`)

  for (let i = 0; i < events.length; i += 400) {
    const chunk = events.slice(i, i + 400)
    const params = []
    const tuples = chunk.map((e, r) => {
      COLS.forEach((c) => params.push(e[c] ?? null))
      return `(${COLS.map((_, k) => '$' + (r * COLS.length + k + 1)).join(',')})`
    })
    await pool.query(`INSERT INTO events (${COLS.join(',')}) VALUES ${tuples.join(',')}`, params)
  }

  const alerts = replayEvents(events)
  for (const a of alerts) {
    await pool.query(
      `INSERT INTO alerts (created_at, rule_id, rule_name, severity, subject_type, user_ref, device_ref, session_ref, details, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'dataset')`,
      [new Date(a.created_at), a.rule_id, a.rule_name, a.severity, a.subject_type, a.user_ref, a.device_ref, a.session_ref, JSON.stringify(a.details)]
    )
  }
  console.log(`Imported ${events.length} events and ${alerts.length} alerts${shift ? ' (timestamps shifted to now)' : ''}`)
  console.log(`Remove later with: DELETE FROM events WHERE source='dataset'; DELETE FROM alerts WHERE source='dataset';`)
} catch (e) {
  console.error('Import failed:', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
