import { CONFIG, evaluateUser, evaluateDevice, prep } from './rules.js'

const HORIZON = 15 * 60000

/**
 * Runs the rules over a list of past events in time order, the same way the live engine does
 * (windows reset after a flag, nothing re-fires while the 20 minute block is active).
 * Returns the alerts that would have been raised.
 */
export function replayEvents(rawEvents, cfg = CONFIG) {
  const events = rawEvents.map(prep).sort((a, b) => a.t - b.t)
  const byUser = new Map()
  const byDevice = new Map()
  const flaggedAt = new Map() // 'u:ref' | 'd:ref' -> flag time
  const alerts = []

  const push = (map, key, e) => {
    if (!map.has(key)) map.set(key, [])
    const arr = map.get(key)
    arr.push(e)
    while (arr.length && arr[0].t < e.t - HORIZON) arr.shift()
    return arr
  }
  const blocked = (key, t) => flaggedAt.has(key) && t < flaggedAt.get(key) + cfg.blockMinutes * 60000

  for (const e of events) {
    if (e.user_ref) {
      const arr = push(byUser, e.user_ref, e)
      const key = 'u:' + e.user_ref
      if (!blocked(key, e.t)) {
        const since = flaggedAt.get(key) ?? 0
        const { hits } = evaluateUser(arr.filter((x) => x.t > since), e.t, cfg)
        if (hits.length) {
          flaggedAt.set(key, e.t)
          for (const h of hits) alerts.push({ ...h, subject_type: 'user', user_ref: e.user_ref, device_ref: e.device_ref, session_ref: e.session_ref, created_at: e.t })
        }
      }
    }
    if (e.event_category === 'LOGIN' && e.device_ref) {
      const arr = push(byDevice, e.device_ref, e)
      const key = 'd:' + e.device_ref
      if (!blocked(key, e.t)) {
        const since = flaggedAt.get(key) ?? 0
        const { hits } = evaluateDevice(arr.filter((x) => x.t > since), e.t, cfg)
        if (hits.length) {
          flaggedAt.set(key, e.t)
          for (const h of hits) alerts.push({ ...h, subject_type: 'device', user_ref: null, device_ref: e.device_ref, session_ref: e.session_ref, created_at: e.t })
        }
      }
    }
  }
  return alerts
}
