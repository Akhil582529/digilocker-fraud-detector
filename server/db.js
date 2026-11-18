import pg from 'pg'
import 'dotenv/config'

// Hosted Postgres reached over the public internet (Render external URL, Neon, Supabase) needs SSL.
// Set DATABASE_SSL=true there. Local Postgres and Docker Compose do not need it.
const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl })
