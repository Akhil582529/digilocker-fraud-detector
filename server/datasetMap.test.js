import { describe, it, expect } from 'vitest'
import { fromCsvRow } from './datasetMap.js'

describe('fromCsvRow', () => {
  const row = {
    event_time: '2026-10-26T10:00:00Z', event_category: 'LOGIN', user_ref: 'user_0001', session_ref: 'sess_9',
    device_ref: 'dev_3', device_trust_status: 'new', login_result: 'failure', login_failure_reason: 'invalid_credential',
    otp_event_type: '', otp_verification_result: '', account_recovery_event: 'False', document_ref: '',
    ownership_check_result: '', authorization_result: '', response_action: 'deny', response_reason: 'invalid_credential',
    some_other_column_from_the_160: 'ignored',
  }

  it('keeps the rule columns and drops everything else', () => {
    const out = fromCsvRow(row)
    expect(out.user_ref).toBe('user_0001')
    expect(out.device_trust_status).toBe('new')
    expect(out).not.toHaveProperty('some_other_column_from_the_160')
  })

  it('turns empty strings and missing columns into null', () => {
    const out = fromCsvRow(row)
    expect(out.otp_event_type).toBeNull()
    expect(out.document_ref).toBeNull()
    expect(out.document_action).toBeNull()
  })

  it('parses the recovery flag as a boolean', () => {
    expect(fromCsvRow({ ...row, account_recovery_event: 'True' }).account_recovery_event).toBe(true)
    expect(fromCsvRow({ ...row, account_recovery_event: 'False' }).account_recovery_event).toBe(false)
    expect(fromCsvRow({ ...row, account_recovery_event: '' }).account_recovery_event).toBe(false)
  })

  it('uses the user as the attempted account', () => {
    expect(fromCsvRow(row).attempted_ref).toBe('user_0001')
  })
})
