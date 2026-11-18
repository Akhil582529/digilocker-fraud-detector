import path from 'path'
import { fileURLToPath } from 'url'
import { pool } from './db.js'

// Safe by default: creates what is missing and never drops data.
// `node server/schema.js --reset` (npm run db:reset) drops everything first.
const DROP = `DROP TABLE IF EXISTS alerts, events, blocked_devices, user_devices, documents, otps, auth_logs, users CASCADE;`

const CREATE = `

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  user_ref      TEXT GENERATED ALWAYS AS ('usr_' || lpad(id::text, 4, '0')) STORED,
  full_name     TEXT NOT NULL,
  mobile        CHAR(10) UNIQUE NOT NULL,
  aadhaar_hash  TEXT UNIQUE NOT NULL,
  aadhaar_last4 CHAR(4) NOT NULL,
  dob           DATE NOT NULL,
  pin_hash      TEXT NOT NULL,
  blocked_until TIMESTAMPTZ,            -- set when a rule flags the account
  block_reason  TEXT,                   -- e.g. 'R1' or 'R4,R8'
  last_flag_at  TIMESTAMPTZ,            -- rules only look at events after this moment
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_ref)
);

CREATE TABLE IF NOT EXISTS otps (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash   TEXT NOT NULL,
  purpose    TEXT NOT NULL,             -- pin_reset | kyc
  used       BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  doc_ref    TEXT PRIMARY KEY,
  owner_ref  TEXT NOT NULL,
  doc_type   TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents (owner_ref);

CREATE TABLE IF NOT EXISTS user_devices (
  user_ref   TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_ref, device_ref)
);

CREATE TABLE IF NOT EXISTS blocked_devices (
  device_ref    TEXT PRIMARY KEY,
  flagged_at    TIMESTAMPTZ NOT NULL,
  blocked_until TIMESTAMPTZ NOT NULL,
  rule_id       TEXT
);

-- Lean event log: only the columns the 8 rules need (names match the dataset)
CREATE TABLE IF NOT EXISTS events (
  event_id                BIGSERIAL PRIMARY KEY,
  event_time              TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_category          TEXT NOT NULL,   -- LOGIN | OTP | ACCOUNT_RECOVERY | DOCUMENT_FETCH | DOCUMENT_DOWNLOAD | DOCUMENT_SHARE
  user_ref                TEXT,            -- null when the account does not exist
  attempted_ref           TEXT,            -- account the actor tried to use (user_ref, or hash for unknown ones)
  session_ref             TEXT,
  device_ref              TEXT,
  device_trust_status     TEXT,            -- new | known
  login_result            TEXT,            -- success | failure | blocked
  login_failure_reason    TEXT,
  otp_event_type          TEXT,            -- SEND | VERIFY
  otp_verification_result TEXT,            -- success | failure
  account_recovery_event  BOOLEAN NOT NULL DEFAULT false,
  document_action         TEXT,            -- fetch | download | share
  document_type           TEXT,
  document_ref            TEXT,
  ownership_check_result  TEXT,            -- match | mismatch
  authorization_result    TEXT,            -- allowed | denied
  response_action         TEXT,            -- allow | deny
  response_reason         TEXT,
  rule_triggered_ref      TEXT,            -- filled by the rule engine, e.g. 'R1'
  source                  TEXT NOT NULL DEFAULT 'live'   -- live | dataset
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_ref, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_device ON events (device_ref, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_category ON events (event_category);

CREATE TABLE IF NOT EXISTS alerts (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_id       TEXT NOT NULL,
  rule_name     TEXT NOT NULL,
  severity      TEXT NOT NULL,             -- medium | high | critical
  subject_type  TEXT NOT NULL,             -- user | device
  user_ref      TEXT,
  device_ref    TEXT,
  session_ref   TEXT,
  details       JSONB,
  blocked_until TIMESTAMPTZ,
  source        TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts (rule_id);
`

export async function ensureSchema(db = pool, { reset = false } = {}) {
  if (reset) await db.query(DROP)
  await db.query(CREATE)
}

// CLI: node server/schema.js [--reset]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reset = process.argv.includes('--reset')
  try {
    await ensureSchema(pool, { reset })
    console.log(reset ? 'Schema reset: all tables dropped and recreated' : 'Schema ready (existing data kept)')
  } catch (err) {
    console.error('Schema creation failed:', err.message)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
