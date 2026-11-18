import { describe, it, expect } from 'vitest'
import { replayEvents } from './replay.js'

const T0 = Date.UTC(2026, 10, 16, 10, 0, 0)
const MIN = 60000
const fail = (m, user = 'user_a', extra = {}) => ({
  event_time: new Date(T0 + m * MIN).toISOString(),
  event_category: 'LOGIN', login_result: 'failure', user_ref: user, attempted_ref: user, session_ref: 'sess_1', device_ref: 'dev_1', ...extra,
})

describe('replayEvents', () => {
  it('raises one alert for a burst and stays quiet while the 20 minute block runs', () => {
    const alerts = replayEvents(Array.from({ length: 9 }, (_, i) => fail(i)))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ rule_id: 'R1', subject_type: 'user', user_ref: 'user_a', session_ref: 'sess_1' })
  })

  it('alerts again for a fresh burst after the block has ended', () => {
    const first = Array.from({ length: 5 }, (_, i) => fail(i))
    const second = Array.from({ length: 5 }, (_, i) => fail(30 + i))
    expect(replayEvents([...first, ...second])).toHaveLength(2)
  })

  it('does not carry old failures into the window after a flag', () => {
    // flagged at minute 4; 4 more failures after the block must not re-trigger using old events
    const events = [...Array.from({ length: 5 }, (_, i) => fail(i)), ...Array.from({ length: 4 }, (_, i) => fail(25 + i))]
    expect(replayEvents(events)).toHaveLength(1)
  })

  it('tracks users separately', () => {
    const a = Array.from({ length: 5 }, (_, i) => fail(i, 'user_a'))
    const b = Array.from({ length: 4 }, (_, i) => fail(i, 'user_b'))
    const alerts = replayEvents([...a, ...b])
    expect(alerts.map((x) => x.user_ref)).toEqual(['user_a'])
  })

  it('raises a device alert for many accounts from one device', () => {
    const events = Array.from({ length: 10 }, (_, i) => fail(i, null, { user_ref: null, attempted_ref: `acct_${i}`, device_ref: 'dev_bad' }))
    const alerts = replayEvents(events)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ rule_id: 'R6', subject_type: 'device', device_ref: 'dev_bad' })
  })

  it('handles events given out of order', () => {
    const events = Array.from({ length: 5 }, (_, i) => fail(i)).reverse()
    expect(replayEvents(events)).toHaveLength(1)
  })

  it('returns nothing for benign activity', () => {
    expect(replayEvents([fail(0), fail(20), fail(40)])).toEqual([])
  })
})
