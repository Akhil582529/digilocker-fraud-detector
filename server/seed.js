import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { pool } from './db.js'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

const users = [
  { name: 'Demo User One', mobile: '9876543210', aadhaar: '234567890123', dob: '2003-05-14', pin: '123456' },
  { name: 'Demo User Two', mobile: '9123456780', aadhaar: '345678901234', dob: '2002-11-02', pin: '123456' },
]

for (const u of users) {
  await pool.query(
    `INSERT INTO users (full_name, mobile, aadhaar_hash, aadhaar_last4, dob, pin_hash)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [u.name, u.mobile, sha(u.aadhaar), u.aadhaar.slice(-4), u.dob, await bcrypt.hash(u.pin, 10)]
  )
}

console.log('Seeded', users.length, 'users')
await pool.end()
