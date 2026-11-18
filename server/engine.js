import { EventEmitter } from 'events'
import crypto from 'crypto'
import { pool } from './db.js'
import { CONFIG, evaluateUser, evaluateDevice, prep } from './rules.js'

// Anything that changes (new event, new alert) pings this so the dashboard can refresh live
export const bus = new EventEmitter()
bus.setMaxListeners(200)

const HORIZON_MS = 15 * 60000
const NEW_DEVICE_HOURS = 24

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const unknownRef = (value) => 'unk_' + sha(String(value ?? '')).slice(0, 10)

const clean = (v) => (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : null)
export const clientCtx = (req) => ({
  session_ref: clean(req.headers['x-session-id']),
  device_ref: clean(req.headers['x-device-id']),
})

/* ---------- device trust ---------- */
export async function deviceStatus(userRef, deviceRef) {
  if (!userRef || !deviceRef) return null
  const { rows } = await pool.query('SELECT first_seen FROM user_devices WHERE user_ref=$1 AND device_ref=$2', [userRef, deviceRef])
  if (rows[0]) return Date.now() - rows[0].first_seen.getTime() < NEW_DEVICE_HOURS * 3600e3 ? 'new' : 'known'
  const any = await pool.query('SELECT 1 FROM user_devices WHERE user_ref=$1 LIMIT 1', [userRef])
  return any.rowCount ? 'new' : 'known' // a user's very first device is their baseline
}

export async function registerDevice(userRef, deviceRef) {
  if (!userRef || !deviceRef) return
  const any = await pool.query('SELECT 1 FROM user_devices WHERE user_ref=$1 LIMIT 1', [userRef])
  const baseline = any.rowCount === 0
  await pool.query(
    `INSERT INTO user_devices (user_ref, device_ref, first_seen)
     VALUES ($1, $2, CASE WHEN $3::boolean THEN now() - interval '30 days' ELSE now() END)
     ON CONFLICT DO NOTHING`,
    [userRef, deviceRef, baseline]
  )
}

/* ---------- block state ---------- */
export const isBlocked = (user) => !!user?.blocked_until && new Date(user.blocked_until) > new Date()

export async function deviceBlockedUntil(deviceRef) {
  if (!deviceRef) return null
  const { rows } = await pool.query('SELECT blocked_until FROM blocked_devices WHERE device_ref=$1 AND blocked_until > now()', [deviceRef])
  return rows[0]?.blocked_until || null
}

/* ---------- logging + checking ---------- */
const COLS = [
  'event_time', 'event_category', 'user_ref', 'attempted_ref', 'session_ref', 'device_ref', 'device_trust_status',
  'login_result', 'login_failure_reason', 'otp_event_type', 'otp_verification_result', 'account_recovery_event',
  'document_action', 'document_type', 'document_ref', 'ownership_check_result', 'authorization_result',
  'response_action', 'response_reason',
]

/**
 * Stores one event in Postgres and runs the rules against it.
 * Returns { flagged, counts }. `flagged` is set when this event pushed the account (or device) over a rule.
 */
export async function recordEvent(req, ev) {
  const row = { event_time: new Date(), ...clientCtx(req), ...ev }
  if (row.user_ref && !('device_trust_status' in ev)) row.device_trust_status = await deviceStatus(row.user_ref, row.device_ref)
  if (!row.attempted_ref) row.attempted_ref = row.user_ref ?? null

  const vals = COLS.map((c) => (c === 'account_recovery_event' ? !!row[c] : row[c] ?? null))
  const { rows } = await pool.query(
    `INSERT INTO events (${COLS.join(',')}) VALUES (${COLS.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING event_id`,
    vals
  )
  row.event_id = rows[0].event_id
  bus.emit('change')

  const result = await runChecks(row)
  return result
}

async function runChecks(row) {
  const out = { flagged: null, counts: {} }
  const now = row.event_time.getTime()

  // account level rules
  if (row.user_ref) {
    const { rows: [u] } = await pool.query('SELECT user_ref, last_flag_at FROM users WHERE user_ref=$1', [row.user_ref])
    if (u) {
      const since = Math.max(now - HORIZON_MS, u.last_flag_at ? u.last_flag_at.getTime() : 0)
      const { rows } = await pool.query('SELECT * FROM events WHERE user_ref=$1 AND event_time > $2 ORDER BY event_time', [u.user_ref, new Date(since)])
      const { hits, counts } = evaluateUser(rows.map(prep), now)
      out.counts = counts
      if (hits.length) out.flagged = await flagUser(u.user_ref, row, hits)
    }
  }

  // device level rule (many accounts from one device)
  if (row.event_category === 'LOGIN' && row.device_ref) {
    const { rows: [d] } = await pool.query('SELECT flagged_at FROM blocked_devices WHERE device_ref=$1', [row.device_ref])
    const since = Math.max(now - HORIZON_MS, d ? d.flagged_at.getTime() : 0)
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE device_ref=$1 AND event_category='LOGIN' AND event_time > $2 ORDER BY event_time`,
      [row.device_ref, new Date(since)]
    )
    const { hits } = evaluateDevice(rows.map(prep), now)
    if (hits.length) {
      const flag = await flagDevice(row.device_ref, row, hits)
      if (!out.flagged) out.flagged = flag
    }
  }
  return out
}

const until = (row) => new Date(row.event_time.getTime() + CONFIG.blockMinutes * 60000)

async function insertAlerts(subjectType, row, hits, blockedUntil) {
  for (const h of hits) {
    await pool.query(
      `INSERT INTO alerts (created_at, rule_id, rule_name, severity, subject_type, user_ref, device_ref, session_ref, details, blocked_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.event_time, h.rule_id, h.rule_name, h.severity, subjectType,
        subjectType === 'user' ? row.user_ref : null, row.device_ref, row.session_ref, JSON.stringify(h.details), blockedUntil]
    )
  }
  const ids = hits.map((h) => h.rule_id).join(',')
  await pool.query('UPDATE events SET rule_triggered_ref=$2 WHERE event_id=$1', [row.event_id, ids])
  bus.emit('change')
  return ids
}

async function flagUser(userRef, row, hits) {
  const blockedUntil = until(row)
  const ids = hits.map((h) => h.rule_id).join(',')
  await pool.query('UPDATE users SET blocked_until=$2, last_flag_at=$3, block_reason=$4 WHERE user_ref=$1', [userRef, blockedUntil, row.event_time, ids])
  await insertAlerts('user', row, hits, blockedUntil)
  return { scope: 'user', blockedUntil, reason: ids, rules: hits.map((h) => ({ id: h.rule_id, name: h.rule_name })) }
}

async function flagDevice(deviceRef, row, hits) {
  const blockedUntil = until(row)
  const ids = hits.map((h) => h.rule_id).join(',')
  await pool.query(
    `INSERT INTO blocked_devices (device_ref, flagged_at, blocked_until, rule_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (device_ref) DO UPDATE SET flagged_at=$2, blocked_until=$3, rule_id=$4`,
    [deviceRef, row.event_time, blockedUntil, ids]
  )
  await insertAlerts('device', row, hits, blockedUntil)
  return { scope: 'device', blockedUntil, reason: ids, rules: hits.map((h) => ({ id: h.rule_id, name: h.rule_name })) }
}

export async function clearUserBlock(userRef) {
  await pool.query('UPDATE users SET blocked_until=NULL, block_reason=NULL WHERE user_ref=$1', [userRef])
  bus.emit('change')
}
