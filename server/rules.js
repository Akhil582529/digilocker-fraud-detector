// Pure rule engine: no database, no network. Takes events, returns rule hits.
// Thresholds live in CONFIG so you can tune them in one place.

export const CONFIG = {
  blockMinutes: 20,
  R1: { count: 5, minutes: 10 },                 // failed logins on one account
  R2: { count: 5, minutes: 5 },                  // wrong OTP entries
  R3: { count: 6, minutes: 10 },                 // OTP sends (more than 5)
  R4: { count: 5, minutes: 10 },                 // distinct doc IDs with ownership mismatch
  R5: { count: 21, minutes: 5 },                 // downloads (more than 20)
  R6: { accounts: 10, failures: 5, minutes: 15 },// accounts attempted from one device
  R7: { downloads: 5, minutes: 15 },             // recovery -> new device login -> bulk downloads
  R8: { count: 5, minutes: 10 },                 // access-denied on distinct documents
}

const C = CONFIG
export const RULES = [
  { id: 'R1', name: 'Repeated failed logins', scope: 'user', severity: 'high',
    text: `${C.R1.count} failed logins on one account within ${C.R1.minutes} min` },
  { id: 'R2', name: 'Wrong OTP entries', scope: 'user', severity: 'high',
    text: `${C.R2.count} incorrect OTPs within ${C.R2.minutes} min` },
  { id: 'R3', name: 'Frequent OTP requests', scope: 'user', severity: 'medium',
    text: `More than ${C.R3.count - 1} OTP sends within ${C.R3.minutes} min` },
  { id: 'R4', name: 'Multiple document identifiers', scope: 'user', severity: 'high',
    text: `${C.R4.count} distinct document IDs with ownership mismatch within ${C.R4.minutes} min` },
  { id: 'R5', name: 'Sudden bulk downloads', scope: 'user', severity: 'high',
    text: `More than ${C.R5.count - 1} downloads within ${C.R5.minutes} min (critical on a new device)` },
  { id: 'R6', name: 'Many accounts from one device', scope: 'device', severity: 'high',
    text: `${C.R6.accounts} accounts attempted from one device within ${C.R6.minutes} min, with repeated failures` },
  { id: 'R7', name: 'Recovery then bulk downloads', scope: 'user', severity: 'critical',
    text: `Recovery, new-device login, then ${C.R7.downloads}+ downloads within ${C.R7.minutes} min` },
  { id: 'R8', name: 'Unauthorized access', scope: 'user', severity: 'medium',
    text: `${C.R8.count} access-denied events on different documents within ${C.R8.minutes} min` },
]
const RULE = Object.fromEntries(RULES.map((r) => [r.id, r]))

const MIN = 60000
const DOC_CATEGORIES = new Set(['DOCUMENT_FETCH', 'DOCUMENT_DOWNLOAD', 'DOCUMENT_SHARE'])

export const prep = (e) => (typeof e.t === 'number' ? e : { ...e, t: new Date(e.event_time).getTime() })

const hit = (id, details, severity) => ({
  rule_id: id,
  rule_name: RULE[id].name,
  severity: severity || RULE[id].severity,
  details,
})

const distinct = (arr, key) => new Set(arr.map((e) => e[key]).filter(Boolean)).size

/** Rules that look at one account. `events` = that user's events, already trimmed to after the last flag. */
export function evaluateUser(events, nowMs, cfg = CONFIG) {
  const within = (m) => events.filter((e) => e.t > nowMs - m * MIN && e.t <= nowMs)
  const hits = []
  const counts = {}

  // R1 failed logins
  const r1 = within(cfg.R1.minutes).filter((e) => e.event_category === 'LOGIN' && e.login_result === 'failure')
  counts.R1 = r1.length
  if (r1.length >= cfg.R1.count) hits.push(hit('R1', { failures: r1.length, window_min: cfg.R1.minutes }))

  // R2 wrong OTP entries
  const r2 = within(cfg.R2.minutes).filter(
    (e) => e.event_category === 'OTP' && e.otp_event_type === 'VERIFY' && e.otp_verification_result === 'failure'
  )
  counts.R2 = r2.length
  if (r2.length >= cfg.R2.count) hits.push(hit('R2', { wrong_otps: r2.length, window_min: cfg.R2.minutes }))

  // R3 frequent OTP requests
  const r3 = within(cfg.R3.minutes).filter((e) => e.event_category === 'OTP' && e.otp_event_type === 'SEND')
  counts.R3 = r3.length
  if (r3.length >= cfg.R3.count) hits.push(hit('R3', { otp_sends: r3.length, window_min: cfg.R3.minutes }))

  // R4 multiple document identifiers with identity mismatch
  const r4 = within(cfg.R4.minutes).filter((e) => DOC_CATEGORIES.has(e.event_category) && e.ownership_check_result === 'mismatch')
  const r4n = distinct(r4, 'document_ref')
  counts.R4 = r4n
  if (r4n >= cfg.R4.count) hits.push(hit('R4', { distinct_documents: r4n, window_min: cfg.R4.minutes }))

  // R5 sudden bulk downloads
  const r5 = within(cfg.R5.minutes).filter((e) => e.event_category === 'DOCUMENT_DOWNLOAD' && e.response_action === 'allow')
  counts.R5 = r5.length
  if (r5.length >= cfg.R5.count) {
    const newDevice = r5.some((e) => e.device_trust_status === 'new')
    hits.push(hit('R5', { downloads: r5.length, window_min: cfg.R5.minutes, new_device: newDevice }, newDevice ? 'critical' : 'high'))
  }

  // R7 account recovery -> new-device login -> bulk downloads
  for (const rec of within(cfg.R7.minutes).filter((e) => e.event_category === 'ACCOUNT_RECOVERY' && e.account_recovery_event)) {
    const end = Math.min(nowMs, rec.t + cfg.R7.minutes * MIN)
    const after = events.filter((e) => e.t >= rec.t && e.t <= end)
    const login = after.find((e) => e.event_category === 'LOGIN' && e.login_result === 'success' && e.device_trust_status === 'new')
    if (!login) continue
    const dl = after.filter((e) => e.event_category === 'DOCUMENT_DOWNLOAD' && e.response_action === 'allow' && e.t >= login.t)
    if (dl.length >= cfg.R7.downloads) {
      hits.push(hit('R7', { downloads_after_recovery: dl.length, device_ref: login.device_ref, window_min: cfg.R7.minutes }))
      break
    }
  }

  // R8 unauthorized access (denied on different documents)
  const r8 = within(cfg.R8.minutes).filter((e) => DOC_CATEGORIES.has(e.event_category) && e.authorization_result === 'denied')
  const r8n = distinct(r8, 'document_ref')
  counts.R8 = r8n
  if (r8n >= cfg.R8.count) hits.push(hit('R8', { distinct_documents: r8n, window_min: cfg.R8.minutes }))

  return { hits, counts }
}

/** Rules that look at one device. `events` = LOGIN events from that device. */
export function evaluateDevice(events, nowMs, cfg = CONFIG) {
  const win = events.filter((e) => e.event_category === 'LOGIN' && e.t > nowMs - cfg.R6.minutes * MIN && e.t <= nowMs)
  const accounts = distinct(win, 'attempted_ref')
  const failures = win.filter((e) => e.login_result === 'failure').length
  const hits = []
  if (accounts >= cfg.R6.accounts && failures >= cfg.R6.failures) {
    hits.push(hit('R6', { accounts_attempted: accounts, failures, window_min: cfg.R6.minutes }))
  }
  return { hits, counts: { R6: accounts } }
}

export const ruleList = (ids = '') =>
  String(ids || '').split(',').filter(Boolean).map((id) => ({ id, name: RULE[id]?.name || id }))
