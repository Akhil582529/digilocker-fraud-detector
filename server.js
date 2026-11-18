import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const LOG_FILE = path.join(__dirname, 'auth_logs.ndjson')

app.use(cors())
app.use(express.json())

// one JSON log per line, easy to stream into your detection engine
app.post('/api/logs', (req, res) => {
  const entry = { ...req.body, ip: req.ip, receivedAt: new Date().toISOString() }
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', (err) => {
    if (err) return res.status(500).json({ ok: false })
    res.json({ ok: true })
  })
})

app.get('/api/logs', (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.json([])
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
  res.json(lines.map((l) => JSON.parse(l)))
})

app.listen(5000, () => console.log('Log server on http://localhost:5000'))