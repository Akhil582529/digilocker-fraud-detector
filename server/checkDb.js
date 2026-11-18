import { pool } from './db.js'

console.log('DATABASE_URL:', (process.env.DATABASE_URL || 'NOT SET').replace(/:[^:@/]+@/, ':****@'))

try {
  const { rows } = await pool.query('SELECT current_database() AS db, current_user AS usr')
  console.log('Connected:', rows[0])

  for (const t of ['users', 'otps', 'documents', 'user_devices', 'blocked_devices', 'events', 'alerts']) {
    try {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${t}`)
      console.log(`✔ ${t}: ${r.rows[0].n} rows`)
    } catch (e) {
      console.log(`✘ ${t}: ${e.message}`)
    }
  }
} catch (e) {
  console.log('✘ Connection failed:', e.message)
} finally {
  await pool.end()
}
