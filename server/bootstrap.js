// Production entry point (used by the Dockerfile): prepares the database, then starts the API.
// - creates missing tables (never drops anything)
// - optionally creates the 8 demo users (SEED_DEMO_USERS=true)
import { pool } from './db.js'
import { ensureSchema } from './schema.js'
import { upsertDemoUsers } from './demoUsers.js'

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production. Refusing to start with the default secret.')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

try {
  await ensureSchema(pool)
  console.log('Database schema ready')
  if (process.env.SEED_DEMO_USERS === 'true') {
    await upsertDemoUsers(pool)
    console.log('Demo users ready (PIN 123456)')
  }
} catch (e) {
  console.error('Could not prepare the database:', e.message)
  process.exit(1)
}

await import('./index.js')
