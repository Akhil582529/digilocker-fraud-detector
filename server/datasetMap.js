// Maps one row of the 160-column dataset CSV to the lean events table (only rule-relevant columns)
const val = (v) => (v === '' || v === undefined || v === null ? null : v)

export const fromCsvRow = (r) => ({
  event_time: r.event_time,
  event_category: r.event_category,
  user_ref: val(r.user_ref),
  attempted_ref: val(r.user_ref),
  session_ref: val(r.session_ref),
  device_ref: val(r.device_ref),
  device_trust_status: val(r.device_trust_status),
  login_result: val(r.login_result),
  login_failure_reason: val(r.login_failure_reason),
  otp_event_type: val(r.otp_event_type),
  otp_verification_result: val(r.otp_verification_result),
  account_recovery_event: r.account_recovery_event === 'True',
  document_action: val(r.document_action),
  document_type: val(r.document_type),
  document_ref: val(r.document_ref),
  ownership_check_result: val(r.ownership_check_result),
  authorization_result: val(r.authorization_result),
  response_action: val(r.response_action),
  response_reason: val(r.response_reason),
})
