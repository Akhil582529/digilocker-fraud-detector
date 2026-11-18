import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'
import { router as authRouter } from './authRoutes.js'
import { router as docRouter } from './docRoutes.js'
import { router as dashboardRouter } from './dashboardRoutes.js'

const app = express()

// Only needed when the frontend is hosted on a different domain (e.g. Vercel).
// Comma separated list: CORS_ORIGINS=https://my-app.vercel.app
const origins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.use(cors({ origin: origins }))
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/docs', docRouter)
app.use('/api/dashboard', dashboardRouter)
app.get('/api/health', (req, res) => res.json({ ok: true }))
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

// Production: serve the built frontend from this same server (one URL, no CORS needed)
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist))
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()))
}

const PORT = process.env.PORT || 5001
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`))
