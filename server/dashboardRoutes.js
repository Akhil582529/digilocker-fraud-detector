import express from 'express'
import { pool } from './db.js'
import { bus, clearUserBlock } from './engine.js'
import { RULES, CONFIG, ruleList } from './rules.js'
import { wrap } from './security.js'

export const router = express.Router()

const RANGES = {
  '15m': { ms: 15 * 60e3, bucket: 60 },
  '1h': { ms: 60 * 60e3, bucket: 300 },
  '24h': { ms: 24 * 3600e3, bucket: 3600 },
  '7d': { ms: 7 * 24 * 3600e3, bucket: 6 * 3600 },
}
const maskMobile = (m = '') => (m.length === 10 ? `${m.slice(0, 2)}XXXXXX${m.slice(-2)}` : null)
const n = (v) => Number(v) || 0

router.get('/summary', wrap(async (req, res) => {
  const range = RANGES[req.query.range] ? req.query.range : '1h'
  const { ms, bucket } = RANGES[range]
  const now = Date.now()
  const since = new Date(now - ms)

  const [kpi, alertKpi, active, series, alertSeries, byRule, bySeverity, recentAlerts, flaggedUsers, flaggedDevices, feed, devices] =
    await Promise.all([
      pool.query(
        `SELECT
           count(*) AS total_events,
           count(*) FILTER (WHERE event_category='LOGIN' AND login_result='success') AS logins_success,
           count(*) FILTER (WHERE event_category='LOGIN' AND login_result='failure') AS logins_failed,
           count(*) FILTER (WHERE event_category='LOGIN' AND login_result='blocked') AS logins_blocked,
           count(DISTINCT user_ref) FILTER (WHERE event_category='LOGIN' AND login_result='success') AS users_logged_in,
           count(*) FILTER (WHERE event_category='DOCUMENT_DOWNLOAD' AND response_action='allow') AS downloads,
           count(*) FILTER (WHERE event_category='DOCUMENT_FETCH') AS fetches,
           count(*) FILTER (WHERE event_category='DOCUMENT_SHARE') AS shares,
           count(*) FILTER (WHERE event_category='OTP' AND otp_event_type='SEND') AS otp_sent,
           count(*) FILTER (WHERE event_category='OTP' AND otp_verification_result='failure') AS otp_failed
         FROM events WHERE event_time >= $1`, [since]),
      pool.query(
        `SELECT count(*) AS alerts, count(DISTINCT user_ref) AS flagged_users, count(DISTINCT device_ref) FILTER (WHERE subject_type='device') AS flagged_devices
         FROM alerts WHERE created_at >= $1`, [since]),
      pool.query(
        `SELECT (SELECT count(*) FROM users WHERE blocked_until > now()) AS users,
                (SELECT count(*) FROM blocked_devices WHERE blocked_until > now()) AS devices`),
      pool.query(
        `SELECT floor(extract(epoch FROM event_time)/$2::int)::bigint AS b,
           count(*) FILTER (WHERE event_category='LOGIN' AND login_result='success') AS login_success,
           count(*) FILTER (WHERE event_category='LOGIN' AND login_result IN ('failure','blocked')) AS login_failed,
           count(*) FILTER (WHERE event_category='OTP') AS otp,
           count(*) FILTER (WHERE event_category LIKE 'DOCUMENT_%') AS documents
         FROM events WHERE event_time >= $1 GROUP BY 1`, [since, bucket]),
      pool.query(
        `SELECT floor(extract(epoch FROM created_at)/$2::int)::bigint AS b, count(*) AS alerts
         FROM alerts WHERE created_at >= $1 GROUP BY 1`, [since, bucket]),
      pool.query(`SELECT rule_id, count(*) AS count FROM alerts WHERE created_at >= $1 GROUP BY 1`, [since]),
      pool.query(`SELECT severity, count(*) AS count FROM alerts WHERE created_at >= $1 GROUP BY 1`, [since]),
      pool.query(
        `SELECT id, created_at, rule_id, rule_name, severity, subject_type, user_ref, device_ref, details
         FROM alerts ORDER BY created_at DESC, id DESC LIMIT 12`),
      pool.query(`SELECT user_ref, mobile, blocked_until, block_reason FROM users WHERE blocked_until > now() ORDER BY blocked_until DESC`),
      pool.query(`SELECT device_ref, blocked_until, rule_id FROM blocked_devices WHERE blocked_until > now() ORDER BY blocked_until DESC`),
      pool.query(
        `SELECT event_id, event_time, event_category, user_ref, attempted_ref, device_ref, login_result, otp_event_type,
                otp_verification_result, document_action, ownership_check_result, response_action, rule_triggered_ref
         FROM events ORDER BY event_time DESC, event_id DESC LIMIT 15`),
      pool.query(
        `SELECT device_ref, count(DISTINCT attempted_ref) AS accounts,
                count(*) FILTER (WHERE login_result='failure') AS failures, max(event_time) AS last_seen
         FROM events WHERE event_category='LOGIN' AND device_ref IS NOT NULL AND event_time >= $1
         GROUP BY device_ref ORDER BY accounts DESC, failures DESC LIMIT 6`, [since]),
    ])

  // time series, with empty buckets filled so the charts have no gaps
  const sMap = new Map(series.rows.map((r) => [Number(r.b), r]))
  const aMap = new Map(alertSeries.rows.map((r) => [Number(r.b), n(r.alerts)]))
  const first = Math.floor(since.getTime() / 1000 / bucket)
  const last = Math.floor(now / 1000 / bucket)
  const timeline = []
  for (let b = first; b <= last; b++) {
    const r = sMap.get(b)
    timeline.push({
      t: b * bucket * 1000,
      login_success: n(r?.login_success), login_failed: n(r?.login_failed), otp: n(r?.otp), documents: n(r?.documents),
      alerts: aMap.get(b) || 0,
    })
  }

  const ruleHits = Object.fromEntries(byRule.rows.map((r) => [r.rule_id, n(r.count)]))
  const k = kpi.rows[0]
  const a = alertKpi.rows[0]

  res.json({
    range, bucketSeconds: bucket, generatedAt: now, blockMinutes: CONFIG.blockMinutes,
    kpis: {
      users_logged_in: n(k.users_logged_in), logins_success: n(k.logins_success), logins_failed: n(k.logins_failed),
      logins_blocked: n(k.logins_blocked), downloads: n(k.downloads), fetches: n(k.fetches), shares: n(k.shares),
      otp_sent: n(k.otp_sent), otp_failed: n(k.otp_failed), total_events: n(k.total_events),
      alerts: n(a.alerts), flagged_users: n(a.flagged_users), flagged_devices: n(a.flagged_devices),
      blocked_now: n(active.rows[0].users) + n(active.rows[0].devices),
    },
    timeline,
    rules: RULES.map((r) => ({ ...r, hits: ruleHits[r.id] || 0 })),
    severity: bySeverity.rows.map((r) => ({ severity: r.severity, count: n(r.count) })),
    recentAlerts: recentAlerts.rows,
    blockedNow: [
      ...flaggedUsers.rows.map((r) => ({ type: 'user', ref: r.user_ref, mobile: maskMobile(r.mobile), blocked_until: r.blocked_until, rules: ruleList(r.block_reason) })),
      ...flaggedDevices.rows.map((r) => ({ type: 'device', ref: r.device_ref, blocked_until: r.blocked_until, rules: ruleList(r.rule_id) })),
    ],
    feed: feed.rows,
    devices: devices.rows.map((r) => ({ device_ref: r.device_ref, accounts: n(r.accounts), failures: n(r.failures), last_seen: r.last_seen })),
  })
}))

// admin: lift a block early (handy during demos)
router.post('/unblock', wrap(async (req, res) => {
  const { type, ref } = req.body
  if (type === 'user') await clearUserBlock(String(ref))
  else if (type === 'device') {
    await pool.query('UPDATE blocked_devices SET blocked_until=now() WHERE device_ref=$1', [String(ref)])
    bus.emit('change')
  } else return res.status(400).json({ error: 'type must be user or device' })
  res.json({ ok: true })
}))

// live updates: the browser re-fetches the summary whenever something changes
router.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write('retry: 3000\n\n')
  let timer
  const push = () => {
    clearTimeout(timer)
    timer = setTimeout(() => res.write(`data: ${Date.now()}\n\n`), 250)
  }
  bus.on('change', push)
  const ping = setInterval(() => res.write(': ping\n\n'), 20000)
  req.on('close', () => {
    bus.off('change', push)
    clearInterval(ping)
    clearTimeout(timer)
  })
})
