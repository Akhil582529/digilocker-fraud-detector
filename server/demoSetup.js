// Creates (or resets) the 8 demo users and wipes live demo state.
// Safe to run before every demo. Keeps any imported dataset rows.
import { pool } from './db.js'
import { DEMO_PIN, DEMO_USERS, upsertDemoUsers } from './demoUsers.js'

try {
  await upsertDemoUsers(pool)

  await pool.query('UPDATE users SET blocked_until=NULL, block_reason=NULL, last_flag_at=NULL')
  await pool.query(`DELETE FROM events WHERE source='live'`)
  await pool.query(`DELETE FROM alerts WHERE source='live'`)
  await pool.query('DELETE FROM blocked_devices')
  await pool.query('DELETE FROM user_devices')
  await pool.query('DELETE FROM otps')

  console.log('\nDemo state reset. All demo users use PIN', DEMO_PIN, '\n')
  console.log('Name'.padEnd(14), 'Mobile'.padEnd(12), 'Aadhaar'.padEnd(14), 'DOB'.padEnd(12), 'Use for')
  for (const u of DEMO_USERS) console.log(u.name.padEnd(14), u.mobile.padEnd(12), u.aadhaar.padEnd(14), u.dob.padEnd(12), u.rule)
  console.log('')
} catch (e) {
  console.error('Setup failed:', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
