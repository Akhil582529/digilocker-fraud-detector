import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

export const DEMO_PIN = '123456'

export const DEMO_USERS = [
  { name: 'Aarav Sharma', mobile: '9810000001', aadhaar: '200000000001', dob: '2000-01-15', rule: 'FR-01 failed logins + Self KYC' },
  { name: 'Riya Verma',   mobile: '9810000002', aadhaar: '200000000002', dob: '1999-03-22', rule: 'FR-02 wrong OTPs' },
  { name: 'Kabir Singh',  mobile: '9810000003', aadhaar: '200000000003', dob: '2001-07-09', rule: 'FR-12 OTP resends' },
  { name: 'Ananya Gupta', mobile: '9810000004', aadhaar: '200000000004', dob: '2002-11-30', rule: 'FR-03 + FR-07 foreign documents' },
  { name: 'Vihaan Mehta', mobile: '9810000005', aadhaar: '200000000005', dob: '1998-05-18', rule: 'FR-04 bulk downloads' },
  { name: 'Isha Nair',    mobile: '9810000006', aadhaar: '200000000006', dob: '2000-09-02', rule: 'FR-06 recovery chain' },
  { name: 'Rohan Iyer',   mobile: '9810000007', aadhaar: '200000000007', dob: '2003-02-27', rule: 'spare / normal user (no alert)' },
  { name: 'Meera Joshi',  mobile: '9810000008', aadhaar: '200000000008', dob: '1997-12-12', rule: 'spare' },
]

// Creates the demo users, or resets their name / DOB / PIN if they already exist
export async function upsertDemoUsers(db) {
  const pinHash = await bcrypt.hash(DEMO_PIN, 10)
  for (const u of DEMO_USERS) {
    await db.query(
      `INSERT INTO users (full_name, mobile, aadhaar_hash, aadhaar_last4, dob, pin_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (mobile) DO UPDATE SET full_name=EXCLUDED.full_name, aadhaar_hash=EXCLUDED.aadhaar_hash,
         aadhaar_last4=EXCLUDED.aadhaar_last4, dob=EXCLUDED.dob, pin_hash=EXCLUDED.pin_hash`,
      [u.name, u.mobile, sha(u.aadhaar), u.aadhaar.slice(-4), u.dob, pinHash]
    )
  }
}
