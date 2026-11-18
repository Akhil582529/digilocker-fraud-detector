import { describe, it, expect } from 'vitest'
import { CONFIG, RULES, evaluateUser, evaluateDevice, prep, ruleList } from './rules.js'

const MIN = 60000
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0)

// event at "minute" m (can be fractional) relative to T0
const at = (m, fields) => prep({ event_time: new Date(T0 + m * MIN).toISOString(), ...fields })

const loginFail = (m, extra = {}) => at(m, { event_category: 'LOGIN', login_result: 'failure', ...extra })
const loginOk = (m, trust = 'known') => at(m, { event_category: 'LOGIN', login_result: 'success', device_trust_status: trust })
const otpWrong = (m) => at(m, { event_category: 'OTP', otp_event_type: 'VERIFY', otp_verification_result: 'failure' })
const otpSend = (m) => at(m, { event_category: 'OTP', otp_event_type: 'SEND' })
const download = (m, trust = 'known', extra = {}) =>
  at(m, { event_category: 'DOCUMENT_DOWNLOAD', response_action: 'allow', device_trust_status: trust, document_ref: `doc_${m}`, ...extra })
const foreign = (m, ref) =>
  at(m, { event_category: 'DOCUMENT_FETCH', document_ref: ref, ownership_check_result: 'mismatch', authorization_result: 'denied', response_action: 'deny' })
const recovery = (m) => at(m, { event_category: 'ACCOUNT_RECOVERY', account_recovery_event: true })

const nowOf = (events) => Math.max(...events.map((e) => e.t))
const run = (events) => evaluateUser(events, nowOf(events))
const ids = (res) => res.hits.map((h) => h.rule_id)
const range = (n, step = 1, start = 0) => Array.from({ length: n }, (_, i) => start + i * step)

describe('FR-01 repeated failed logins (R1)', () => {
  it('does not flag 4 failures in 10 minutes', () => {
    const res = run(range(4).map((m) => loginFail(m)))
    expect(ids(res)).not.toContain('R1')
    expect(res.counts.R1).toBe(4)
  })

  it('flags 5 failures in 10 minutes as high severity', () => {
    const res = run(range(5).map((m) => loginFail(m)))
    expect(ids(res)).toContain('R1')
    expect(res.hits.find((h) => h.rule_id === 'R1').severity).toBe('high')
  })

  it('ignores failures that fall outside the 10 minute window', () => {
    // minutes 0,3,6,9,12: only 4 are inside the window that ends at minute 12
    const res = run([0, 3, 6, 9, 12].map((m) => loginFail(m)))
    expect(ids(res)).not.toContain('R1')
  })

  it('does not count successful logins', () => {
    const events = [...range(4).map((m) => loginFail(m)), loginOk(4)]
    expect(ids(run(events))).not.toContain('R1')
  })
})

describe('FR-02 incorrect OTP submissions (R2)', () => {
  it('does not flag 4 wrong OTPs', () => {
    expect(ids(run(range(4).map(otpWrong)))).not.toContain('R2')
  })

  it('flags 5 wrong OTPs within 5 minutes', () => {
    const res = run(range(5).map(otpWrong))
    expect(ids(res)).toContain('R2')
    expect(res.counts.R2).toBe(5)
  })

  it('ignores wrong OTPs spread over more than 5 minutes', () => {
    expect(ids(run([0, 2, 4, 6, 8].map(otpWrong)))).not.toContain('R2')
  })

  it('does not count correct OTP verifications', () => {
    const ok = at(4, { event_category: 'OTP', otp_event_type: 'VERIFY', otp_verification_result: 'success' })
    expect(ids(run([...range(4).map(otpWrong), ok]))).not.toContain('R2')
  })
})

describe('FR-12 frequent OTP requests (R3)', () => {
  it('does not flag 5 OTP sends in 10 minutes', () => {
    expect(ids(run(range(5).map(otpSend)))).not.toContain('R3')
  })

  it('flags more than 5 sends (the 6th) in 10 minutes as medium', () => {
    const res = run(range(6).map(otpSend))
    expect(ids(res)).toContain('R3')
    expect(res.hits.find((h) => h.rule_id === 'R3').severity).toBe('medium')
  })

  it('ignores sends outside the window', () => {
    // 6 sends over 10.5 minutes: only 5 are inside the window ending at the last one
    expect(ids(run([0, 2, 4, 6, 8, 10.5].map(otpSend)))).not.toContain('R3')
  })

  it('does not count OTP verifications as sends', () => {
    expect(ids(run([...range(5).map(otpSend), otpWrong(5)]))).not.toContain('R3')
  })
})

describe('FR-03 multiple document identifiers (R4)', () => {
  it('flags 5 distinct foreign documents in 10 minutes', () => {
    const res = run(range(5).map((m) => foreign(m, `doc_9000${m}`)))
    expect(ids(res)).toContain('R4')
    expect(res.counts.R4).toBe(5)
  })

  it('does not flag 4 distinct documents', () => {
    expect(ids(run(range(4).map((m) => foreign(m, `doc_9000${m}`))))).not.toContain('R4')
  })

  it('counts distinct identifiers, so repeating one document does not trigger', () => {
    expect(ids(run(range(8).map((m) => foreign(m, 'doc_90001'))))).not.toContain('R4')
  })

  it('ignores documents that matched ownership', () => {
    const owned = range(6).map((m) => at(m, { event_category: 'DOCUMENT_FETCH', document_ref: `doc_${m}`, ownership_check_result: 'match', authorization_result: 'allowed' }))
    const res = run(owned)
    expect(ids(res)).not.toContain('R4')
    expect(ids(res)).not.toContain('R8')
  })
})

describe('FR-04 sudden bulk downloads (R5)', () => {
  it('does not flag 20 downloads in 5 minutes', () => {
    expect(ids(run(range(20, 0.2).map((m) => download(m))))).not.toContain('R5')
  })

  it('flags 21 downloads in 5 minutes as high on a known device', () => {
    const res = run(range(21, 0.2).map((m) => download(m)))
    const hit = res.hits.find((h) => h.rule_id === 'R5')
    expect(hit.severity).toBe('high')
    expect(hit.details.new_device).toBe(false)
  })

  it('upgrades to critical when a download came from a new device', () => {
    const events = range(21, 0.2).map((m) => download(m, m === 0 ? 'new' : 'known'))
    const hit = run(events).hits.find((h) => h.rule_id === 'R5')
    expect(hit.severity).toBe('critical')
    expect(hit.details.new_device).toBe(true)
  })

  it('does not flag 21 downloads spread over more than 5 minutes', () => {
    expect(ids(run(range(21, 0.5).map((m) => download(m))))).not.toContain('R5')
  })

  it('ignores denied downloads', () => {
    const denied = range(25, 0.1).map((m) => download(m, 'known', { response_action: 'deny' }))
    expect(ids(run(denied))).not.toContain('R5')
  })

  it('never raises an alert for a new device on its own', () => {
    const res = run([loginOk(0, 'new'), download(1, 'new')])
    expect(res.hits).toEqual([])
  })
})

describe('FR-06 recovery, new device login, bulk downloads (R7)', () => {
  const chain = (downloads = 5, loginTrust = 'new') => [
    recovery(0),
    loginOk(2, loginTrust),
    ...range(downloads, 1, 3).map((m) => download(m, 'new')),
  ]

  it('flags recovery, then new-device login, then 5 downloads as critical', () => {
    const hit = run(chain()).hits.find((h) => h.rule_id === 'R7')
    expect(hit).toBeTruthy()
    expect(hit.severity).toBe('critical')
  })

  it('does not flag 4 downloads', () => {
    expect(ids(run(chain(4)))).not.toContain('R7')
  })

  it('does not flag when the login is from a known device', () => {
    expect(ids(run(chain(5, 'known')))).not.toContain('R7')
  })

  it('does not flag the same downloads without a recovery event', () => {
    expect(ids(run(chain().slice(1)))).not.toContain('R7')
  })

  it('requires the downloads to come after the new-device login', () => {
    const events = [recovery(0), ...range(5, 1, 1).map((m) => download(m, 'new')), loginOk(7, 'new')]
    expect(ids(run(events))).not.toContain('R7')
  })

  it('does not flag when the recovery is older than 15 minutes', () => {
    const events = [recovery(0), loginOk(1, 'new'), ...range(5, 1, 17).map((m) => download(m, 'new'))]
    expect(ids(run(events))).not.toContain('R7')
  })
})

describe('FR-07 repeated unauthorized access (R8)', () => {
  it('flags 5 distinct documents with access denied as medium', () => {
    const res = run(range(5).map((m) => foreign(m, `doc_8000${m}`)))
    const hit = res.hits.find((h) => h.rule_id === 'R8')
    expect(hit.severity).toBe('medium')
  })

  it('does not flag repeated denials on the same document', () => {
    expect(ids(run(range(8).map((m) => foreign(m, 'doc_80001'))))).not.toContain('R8')
  })

  it('counts denied access on documents the user owns (consent or authorization denials)', () => {
    const events = range(5).map((m) => at(m, {
      event_category: 'DOCUMENT_FETCH', document_ref: `doc_${m}`, ownership_check_result: 'match', authorization_result: 'denied',
    }))
    const res = run(events)
    expect(ids(res)).toContain('R8')
    expect(ids(res)).not.toContain('R4')
  })

  it('fires together with R4 when someone probes other people documents', () => {
    const res = run(range(5).map((m) => foreign(m, `doc_7000${m}`)))
    expect(ids(res).sort()).toEqual(['R4', 'R8'])
  })
})

describe('FR-05 many accounts from one device (R6)', () => {
  const attempts = (accounts, failures = accounts, spacing = 1) =>
    range(accounts).map((i) =>
      at(i * spacing, {
        event_category: 'LOGIN',
        device_ref: 'device_x',
        attempted_ref: `acct_${i}`,
        login_result: i < failures ? 'failure' : 'success',
      })
    )
  const runDevice = (events) => evaluateDevice(events, nowOf(events))

  it('flags 10 distinct accounts with failures within 15 minutes', () => {
    const res = runDevice(attempts(10))
    expect(res.hits[0].rule_id).toBe('R6')
    expect(res.hits[0].details.accounts_attempted).toBe(10)
  })

  it('does not flag 9 accounts', () => {
    expect(runDevice(attempts(9)).hits).toEqual([])
  })

  it('does not flag 10 accounts without repeated failures', () => {
    expect(runDevice(attempts(10, 2)).hits).toEqual([])
  })

  it('counts distinct accounts, not attempts', () => {
    const same = range(12).map((i) => at(i, { event_category: 'LOGIN', attempted_ref: 'acct_1', login_result: 'failure' }))
    expect(runDevice(same).hits).toEqual([])
  })

  it('ignores accounts tried outside the 15 minute window', () => {
    expect(runDevice(attempts(10, 10, 2)).hits).toEqual([]) // spread over 18 minutes
  })

  it('ignores non-login events', () => {
    const noise = range(12).map((i) => at(i, { event_category: 'OTP', attempted_ref: `acct_${i}`, login_result: 'failure' }))
    expect(runDevice(noise).hits).toEqual([])
  })
})

describe('rule catalogue and helpers', () => {
  it('defines the 8 rules with unique ids', () => {
    expect(RULES).toHaveLength(8)
    expect(new Set(RULES.map((r) => r.id)).size).toBe(8)
  })

  it('keeps the agreed thresholds', () => {
    expect(CONFIG.R1).toEqual({ count: 5, minutes: 10 })
    expect(CONFIG.R2).toEqual({ count: 5, minutes: 5 })
    expect(CONFIG.R5.count).toBe(21) // more than 20
    expect(CONFIG.R6.accounts).toBe(10)
    expect(CONFIG.blockMinutes).toBe(20)
  })

  it('respects a custom config', () => {
    const cfg = { ...CONFIG, R1: { count: 3, minutes: 10 } }
    const res = evaluateUser(range(3).map((m) => loginFail(m)), T0 + 2 * MIN, cfg)
    expect(ids(res)).toContain('R1')
  })

  it('prep adds a numeric timestamp and is idempotent', () => {
    const p = prep({ event_time: new Date(T0) })
    expect(p.t).toBe(T0)
    expect(prep(p)).toBe(p)
  })

  it('ruleList maps ids to names and tolerates empty input', () => {
    expect(ruleList('R1,R4')).toEqual([
      { id: 'R1', name: 'Repeated failed logins' },
      { id: 'R4', name: 'Multiple document identifiers' },
    ])
    expect(ruleList('')).toEqual([])
    expect(ruleList(null)).toEqual([])
    expect(ruleList('R99')).toEqual([{ id: 'R99', name: 'R99' }])
  })

  it('returns no hits for an empty history', () => {
    expect(evaluateUser([], T0).hits).toEqual([])
  })
})
