import jwt from 'jsonwebtoken'
import 'dotenv/config'
import { pool } from './db.js'
import { isBlocked } from './engine.js'
import { ruleList } from './rules.js'

export const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret'
export const signToken = (user) => jwt.sign({ uid: user.id, ref: user.user_ref }, JWT_SECRET, { expiresIn: '2h' })

export const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e)
    res.status(500).json({ error: 'Server error, try again' })
  })

// Self KYC is the way back in after a flag, except when the flag came from the OTP rules (R2/R3),
// because KYC itself is OTP based and would be a bypass.
export const kycAllowedFor = (reason) => !/R2|R3/.test(reason || '')

// Standard body for "you are flagged" responses
export const flagBody = ({ blockedUntil, reason, rules, scope = 'user' }) => ({
  code: 'FLAGGED',
  scope,
  error: scope === 'device'
    ? 'This device has been flagged for suspicious activity.'
    : 'Your account has been flagged for suspicious activity.',
  blockedUntil,
  rules: rules || ruleList(reason),
  kycAllowed: scope === 'user' && kycAllowedFor(reason),
})

export const userFlagBody = (user) =>
  flagBody({ blockedUntil: user.blocked_until, reason: user.block_reason, scope: 'user' })

export async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || ''
    const token = h.startsWith('Bearer ') ? h.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Please login again' })
    let payload
    try { payload = jwt.verify(token, JWT_SECRET) } catch { return res.status(401).json({ error: 'Session expired, please login again' }) }

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [payload.uid])
    if (!user) return res.status(401).json({ error: 'Please login again' })
    if (isBlocked(user)) return res.status(403).json(userFlagBody(user))
    req.user = user
    next()
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error, try again' })
  }
}
