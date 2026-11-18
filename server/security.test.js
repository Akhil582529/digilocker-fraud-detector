import { describe, it, expect } from 'vitest'
import { kycAllowedFor, flagBody, userFlagBody } from './security.js'
import { isBlocked, unknownRef, clientCtx, sha } from './engine.js'

describe('kycAllowedFor', () => {
  it('allows Self KYC after account level flags', () => {
    expect(kycAllowedFor('R1')).toBe(true)
    expect(kycAllowedFor('R4,R8')).toBe(true)
    expect(kycAllowedFor('R5')).toBe(true)
    expect(kycAllowedFor('R7')).toBe(true)
  })

  it('refuses Self KYC when an OTP rule fired, because KYC itself uses OTP', () => {
    expect(kycAllowedFor('R2')).toBe(false)
    expect(kycAllowedFor('R3')).toBe(false)
    expect(kycAllowedFor('R1,R3')).toBe(false)
  })
})

describe('flagBody', () => {
  const until = new Date(Date.now() + 20 * 60000).toISOString()

  it('describes an account flag with rule names and KYC availability', () => {
    const body = flagBody({ blockedUntil: until, reason: 'R1' })
    expect(body).toMatchObject({ code: 'FLAGGED', scope: 'user', blockedUntil: until, kycAllowed: true })
    expect(body.rules).toEqual([{ id: 'R1', name: 'Repeated failed logins' }])
  })

  it('never offers Self KYC for a flagged device', () => {
    const body = flagBody({ blockedUntil: until, reason: 'R6', scope: 'device' })
    expect(body.scope).toBe('device')
    expect(body.kycAllowed).toBe(false)
    expect(body.error).toMatch(/device/i)
  })

  it('userFlagBody reads the block from a user row', () => {
    const body = userFlagBody({ blocked_until: until, block_reason: 'R2' })
    expect(body.kycAllowed).toBe(false)
    expect(body.rules[0].id).toBe('R2')
  })
})

describe('engine helpers', () => {
  it('isBlocked is true only while blocked_until is in the future', () => {
    expect(isBlocked({ blocked_until: new Date(Date.now() + 60000) })).toBe(true)
    expect(isBlocked({ blocked_until: new Date(Date.now() - 60000) })).toBe(false)
    expect(isBlocked({ blocked_until: null })).toBe(false)
    expect(isBlocked(undefined)).toBe(false)
  })

  it('unknownRef is a stable short hash that hides the identifier', () => {
    const ref = unknownRef('9876543210')
    expect(ref).toMatch(/^unk_[0-9a-f]{10}$/)
    expect(ref).toBe(unknownRef('9876543210'))
    expect(ref).not.toContain('9876543210')
    expect(unknownRef('9876543211')).not.toBe(ref)
  })

  it('clientCtx accepts well formed ids and drops anything odd', () => {
    const ok = clientCtx({ headers: { 'x-session-id': 'sess_abc123', 'x-device-id': 'device_x.y-1' } })
    expect(ok).toEqual({ session_ref: 'sess_abc123', device_ref: 'device_x.y-1' })
    const bad = clientCtx({ headers: { 'x-session-id': "a b'; DROP TABLE users;--", 'x-device-id': 'x'.repeat(100) } })
    expect(bad).toEqual({ session_ref: null, device_ref: null })
    expect(clientCtx({ headers: {} })).toEqual({ session_ref: null, device_ref: null })
  })

  it('sha is a deterministic sha256 hex string', () => {
    expect(sha('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
