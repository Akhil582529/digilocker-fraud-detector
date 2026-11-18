import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { pool } from './db.js'
import { CONFIG } from './rules.js'
import {
  recordEvent, registerDevice, clearUserBlock, deviceBlockedUntil, isBlocked,
  sha, unknownRef, clientCtx,
} from './engine.js'
import { JWT_SECRET, signToken, wrap, requireAuth, flagBody, userFlagBody, kycAllowedFor } from './security.js'

export const router = express.Router()

const OTP_TTL_MIN = 5
const OTP_RESEND_SEC = 10 // UI cooldown only. Abuse is caught by rule R3, not by a hard server limit.

/* ---------- helpers ---------- */
const maskMobile = (m = '') => (m.length === 10 ? `${m.slice(0, 2)}XXXXXX${m.slice(-2)}` : null)
const maskName = (name = '') =>
  name.split(' ').map((w) => (w.length <= 2 ? w[0] + '*' : w[0] + '*'.repeat(w.length - 2) + w[w.length - 1])).join(' ')
const initials = (name = '') => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
const profileOf = (u) => ({ maskedName: maskName(u.full_name), initials: initials(u.full_name) })

const findUser = async ({ type, value } = {}) => {
  const base = `SELECT *, to_char(dob,'YYYY-MM-DD') AS dob_str FROM users WHERE`
  if (type === 'mobile' && /^[6-9]\d{9}$/.test(value)) return (await pool.query(`${base} mobile=$1`, [value])).rows[0] || null
  if (type === 'aadhaar' && /^\d{12}$/.test(value)) return (await pool.query(`${base} aadhaar_hash=$1`, [sha(value)])).rows[0] || null
  return null
}

const issueOtp = async (user, purpose) => {
  const otp = String(crypto.randomInt(100000, 1000000))
  await pool.query('UPDATE otps SET used=true WHERE user_id=$1 AND purpose=$2 AND used=false', [user.id, purpose])
  await pool.query(
    'INSERT INTO otps (user_id, otp_hash, purpose, expires_at) VALUES ($1,$2,$3,$4)',
    [user.id, sha(otp + user.id), purpose, new Date(Date.now() + OTP_TTL_MIN * 60000)]
  )
  console.log(`\n[DEMO SMS] OTP for ${maskMobile(user.mobile)}: ${otp}\n`) // no SMS gateway in the prototype
  return otp
}

// Demo hosting only: with DEMO_SHOW_OTP=true the API also returns the OTP so the UI can show it on screen
// (a hosted demo has no SMS and the reviewer cannot read the server log). Never enable this with real users.
const demoOtp = (otp) => (process.env.DEMO_SHOW_OTP === 'true' ? { demoOtp: otp } : {})

const checkOtp = async (user, purpose, otp) => {
  const { rows } = await pool.query(
    `SELECT * FROM otps WHERE user_id=$1 AND purpose=$2 AND used=false AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [user.id, purpose]
  )
  if (!rows[0] || rows[0].otp_hash !== sha(otp + user.id)) return false
  await pool.query('UPDATE otps SET used=true WHERE id=$1', [rows[0].id])
  return true
}

const left = (limit, used = 0) => Math.max(limit - used, 0)

// 423 = locked/flagged. Used by every login-side endpoint.
const sendFlagged = (res, flagged) => res.status(423).json(flagBody(flagged))

// Rejects requests from a device that rule R6 has flagged
async function deviceGuard(req, res, next) {
  const blockedUntil = await deviceBlockedUntil(clientCtx(req).device_ref)
  if (blockedUntil) return sendFlagged(res, { blockedUntil, scope: 'device', reason: 'R6' })
  next()
}
router.use((req, res, next) => deviceGuard(req, res, next).catch(next))

const unknownAccountEvent = (req, value) =>
  recordEvent(req, {
    event_category: 'LOGIN', attempted_ref: unknownRef(value), login_result: 'failure',
    login_failure_reason: 'unknown_account', response_action: 'deny', response_reason: 'unknown_account',
  })

/* ---------- step 1: mobile number ---------- */
router.post('/check-mobile', wrap(async (req, res) => {
  const { mobile } = req.body
  if (!/^[6-9]\d{9}$/.test(mobile || '')) return res.status(400).json({ error: 'Enter a valid 10 digit mobile number' })

  const user = await findUser({ type: 'mobile', value: mobile })
  if (!user) {
    const r = await unknownAccountEvent(req, mobile)
    if (r.flagged) return sendFlagged(res, r.flagged)
    return res.json({ exists: false })
  }
  res.json({ exists: true, profile: profileOf(user) })
}))

/* ---------- step 2: Aadhaar (when the mobile is not registered) ---------- */
router.post('/check-aadhaar', wrap(async (req, res) => {
  const { aadhaar } = req.body
  if (!/^\d{12}$/.test(aadhaar || '')) return res.status(400).json({ error: 'Enter a valid 12 digit Aadhaar number' })

  const user = await findUser({ type: 'aadhaar', value: aadhaar })
  if (!user) {
    const r = await unknownAccountEvent(req, aadhaar)
    if (r.flagged) return sendFlagged(res, r.flagged)
    return res.json({ exists: false })
  }
  res.json({ exists: true, profile: profileOf(user) })
}))

/* ---------- step 3: security PIN ---------- */
router.post('/verify-pin', wrap(async (req, res) => {
  const { identifier, pin } = req.body
  if (!/^\d{6}$/.test(pin || '')) return res.status(400).json({ error: 'Enter your 6 digit security PIN' })

  const user = await findUser(identifier)
  if (!user) {
    const r = await unknownAccountEvent(req, identifier?.value)
    if (r.flagged) return sendFlagged(res, r.flagged)
    return res.status(404).json({ error: 'Account not found' })
  }

  if (isBlocked(user)) {
    await recordEvent(req, {
      event_category: 'LOGIN', user_ref: user.user_ref, login_result: 'blocked',
      response_action: 'deny', response_reason: 'account_flagged',
    })
    return res.status(423).json(userFlagBody(user))
  }

  const ok = await bcrypt.compare(pin, user.pin_hash)
  if (!ok) {
    const r = await recordEvent(req, {
      event_category: 'LOGIN', user_ref: user.user_ref, login_result: 'failure',
      login_failure_reason: 'invalid_credential', response_action: 'deny', response_reason: 'invalid_credential',
    })
    if (r.flagged) return sendFlagged(res, r.flagged)
    const n = left(CONFIG.R1.count, r.counts.R1)
    return res.status(401).json({ error: `Incorrect PIN. ${n} attempt${n === 1 ? '' : 's'} left before your account is temporarily blocked.` })
  }

  const r = await recordEvent(req, {
    event_category: 'LOGIN', user_ref: user.user_ref, login_result: 'success', response_action: 'allow',
  })
  if (r.flagged) return sendFlagged(res, r.flagged)
  await registerDevice(user.user_ref, clientCtx(req).device_ref)
  res.json({ token: signToken(user), user: { name: user.full_name, ref: user.user_ref } })
}))

/* ---------- forgot PIN: DOB -> OTP -> new PIN ---------- */
const dobTries = new Map() // user_ref -> timestamps of wrong DOB attempts (in memory, prototype only)
const dobLocked = (ref) => {
  const recent = (dobTries.get(ref) || []).filter((t) => Date.now() - t < 15 * 60000)
  dobTries.set(ref, recent)
  return recent.length >= 5
}

router.post('/forgot-pin/verify-dob', wrap(async (req, res) => {
  const { identifier, dob } = req.body
  const user = await findUser(identifier)
  if (!user || !/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) return res.status(400).json({ error: 'Invalid request' })
  if (isBlocked(user)) return res.status(423).json(userFlagBody(user))
  if (dobLocked(user.user_ref)) return res.status(429).json({ error: 'Too many wrong attempts. Try again after 15 minutes.' })

  if (user.dob_str !== dob) {
    dobTries.get(user.user_ref).push(Date.now())
    return res.status(400).json({ error: 'Date of birth does not match your account' })
  }

  const otp = await issueOtp(user, 'pin_reset')
  const r = await recordEvent(req, { event_category: 'OTP', user_ref: user.user_ref, otp_event_type: 'SEND', response_action: 'allow' })
  if (r.flagged) return sendFlagged(res, r.flagged)
  res.json({ ok: true, mobileMasked: `******${user.mobile.slice(-4)}`, resendIn: OTP_RESEND_SEC, ...demoOtp(otp) })
}))

router.post('/forgot-pin/resend-otp', wrap(async (req, res) => {
  const user = await findUser(req.body.identifier)
  if (!user) return res.status(400).json({ error: 'Invalid request' })
  if (isBlocked(user)) return res.status(423).json(userFlagBody(user))

  const otp = await issueOtp(user, 'pin_reset')
  const r = await recordEvent(req, { event_category: 'OTP', user_ref: user.user_ref, otp_event_type: 'SEND', response_action: 'allow' })
  if (r.flagged) return sendFlagged(res, r.flagged)
  res.json({ ok: true, resendIn: OTP_RESEND_SEC, ...demoOtp(otp) })
}))

router.post('/forgot-pin/verify-otp', wrap(async (req, res) => {
  const { identifier, otp } = req.body
  const user = await findUser(identifier)
  if (!user || !/^\d{6}$/.test(otp || '')) return res.status(400).json({ error: 'Enter the 6 digit OTP' })
  if (isBlocked(user)) return res.status(423).json(userFlagBody(user))

  const ok = await checkOtp(user, 'pin_reset', otp)
  const r = await recordEvent(req, {
    event_category: 'OTP', user_ref: user.user_ref, otp_event_type: 'VERIFY',
    otp_verification_result: ok ? 'success' : 'failure', response_action: ok ? 'allow' : 'deny',
  })
  if (r.flagged) return sendFlagged(res, r.flagged)
  if (!ok) {
    const n = left(CONFIG.R2.count, r.counts.R2)
    return res.status(400).json({ error: `Incorrect or expired OTP. ${n} attempt${n === 1 ? '' : 's'} left before your account is temporarily blocked.` })
  }
  res.json({ resetToken: jwt.sign({ uid: user.id, purpose: 'pin_reset' }, JWT_SECRET, { expiresIn: '10m' }) })
}))

router.post('/forgot-pin/reset', wrap(async (req, res) => {
  const { resetToken, newPin } = req.body
  if (!/^\d{6}$/.test(newPin || '')) return res.status(400).json({ error: 'PIN must be 6 digits' })

  let payload
  try {
    payload = jwt.verify(resetToken, JWT_SECRET)
    if (payload.purpose !== 'pin_reset') throw new Error('bad purpose')
  } catch {
    return res.status(401).json({ error: 'Session expired. Start again.' })
  }

  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [payload.uid])
  if (!user) return res.status(401).json({ error: 'Session expired. Start again.' })

  await pool.query('UPDATE users SET pin_hash=$2 WHERE id=$1', [user.id, await bcrypt.hash(newPin, 10)])
  // this is the "account recovery" event that rule R7 chains with a new-device login and bulk downloads
  await recordEvent(req, {
    event_category: 'ACCOUNT_RECOVERY', user_ref: user.user_ref, account_recovery_event: true, response_action: 'allow',
  })
  res.json({ ok: true })
}))

/* ---------- self KYC: Aadhaar -> OTP (way back in after a flag) ---------- */
const kycGate = (res, user) => {
  if (isBlocked(user) && !kycAllowedFor(user.block_reason)) {
    res.status(423).json(userFlagBody(user))
    return false
  }
  return true
}

router.post('/kyc/start', wrap(async (req, res) => {
  const { aadhaar } = req.body
  if (!/^\d{12}$/.test(aadhaar || '')) return res.status(400).json({ error: 'Enter a valid 12 digit Aadhaar number' })

  const user = await findUser({ type: 'aadhaar', value: aadhaar })
  if (!user) {
    const r = await unknownAccountEvent(req, aadhaar)
    if (r.flagged) return sendFlagged(res, r.flagged)
    return res.status(404).json({ error: 'No account found with this Aadhaar number' })
  }
  if (!kycGate(res, user)) return

  const otp = await issueOtp(user, 'kyc')
  const r = await recordEvent(req, { event_category: 'OTP', user_ref: user.user_ref, otp_event_type: 'SEND', response_action: 'allow' })
  if (r.flagged) return sendFlagged(res, r.flagged)
  res.json({ ok: true, mobileMasked: `******${user.mobile.slice(-4)}`, resendIn: OTP_RESEND_SEC, ...demoOtp(otp) })
}))

router.post('/kyc/verify', wrap(async (req, res) => {
  const { aadhaar, otp } = req.body
  const user = await findUser({ type: 'aadhaar', value: aadhaar })
  if (!user || !/^\d{6}$/.test(otp || '')) return res.status(400).json({ error: 'Enter the 6 digit OTP' })
  if (!kycGate(res, user)) return

  const ok = await checkOtp(user, 'kyc', otp)
  const r = await recordEvent(req, {
    event_category: 'OTP', user_ref: user.user_ref, otp_event_type: 'VERIFY',
    otp_verification_result: ok ? 'success' : 'failure', response_action: ok ? 'allow' : 'deny',
  })
  if (r.flagged) return sendFlagged(res, r.flagged)
  if (!ok) {
    const n = left(CONFIG.R2.count, r.counts.R2)
    return res.status(400).json({ error: `Incorrect or expired OTP. ${n} attempt${n === 1 ? '' : 's'} left before your account is temporarily blocked.` })
  }

  await clearUserBlock(user.user_ref) // KYC passed: lift the 20 minute block
  const login = await recordEvent(req, {
    event_category: 'LOGIN', user_ref: user.user_ref, login_result: 'success', response_action: 'allow', response_reason: 'self_kyc',
  })
  if (login.flagged) return sendFlagged(res, login.flagged)
  await registerDevice(user.user_ref, clientCtx(req).device_ref)
  res.json({ token: signToken(user), user: { name: user.full_name, ref: user.user_ref } })
}))

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { name: req.user.full_name, ref: req.user.user_ref } })
})
