import express from 'express'
import crypto from 'crypto'
import { pool } from './db.js'
import { recordEvent } from './engine.js'
import { requireAuth, wrap, flagBody } from './security.js'

export const router = express.Router()
router.use(requireAuth)

const TYPES = [
  ['PASSPORT', 'Passport'],
  ['DRIVING_LICENSE', 'Driving License'],
  ['MARKSHEET', 'Class XII Marksheet'],
  ['RC', 'Vehicle Registration Certificate'],
  ['PAN', 'PAN Card'],
]

// every user gets 5 demo documents the first time they open the app
async function ensureDocs(user) {
  const has = await pool.query('SELECT 1 FROM documents WHERE owner_ref=$1 LIMIT 1', [user.user_ref])
  if (has.rowCount) return
  for (const [type, title] of TYPES) {
    for (let i = 0; i < 6; i++) {
      const ref = 'doc_' + crypto.randomInt(10000, 100000)
      const r = await pool.query(
        'INSERT INTO documents (doc_ref, owner_ref, doc_type, title) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [ref, user.user_ref, type, title]
      )
      if (r.rowCount) break
    }
  }
}

router.get('/', wrap(async (req, res) => {
  await ensureDocs(req.user)
  const { rows } = await pool.query('SELECT doc_ref, doc_type, title FROM documents WHERE owner_ref=$1 ORDER BY doc_type', [req.user.user_ref])
  res.json({ documents: rows })
}))

const handler = (action, category) =>
  wrap(async (req, res) => {
    const user = req.user
    const docRef = String(req.body.docRef || '').trim()
    if (!/^doc_[A-Za-z0-9]{1,16}$/.test(docRef)) return res.status(400).json({ error: 'Enter a valid document ID, like doc_12345' })
    if (action === 'share' && String(req.body.recipient || '').trim().length < 3) {
      return res.status(400).json({ error: 'Enter who to share with (mobile or email)' })
    }

    const { rows: [doc] } = await pool.query('SELECT * FROM documents WHERE doc_ref=$1', [docRef])
    const owned = !!doc && doc.owner_ref === user.user_ref

    const r = await recordEvent(req, {
      event_category: category,
      user_ref: user.user_ref,
      document_action: action,
      document_type: doc?.doc_type ?? null,
      document_ref: docRef,
      ownership_check_result: owned ? 'match' : 'mismatch',
      authorization_result: owned ? 'allowed' : 'denied',
      response_action: owned ? 'allow' : 'deny',
      response_reason: owned ? null : 'authorization_denied',
    })

    if (r.flagged) return res.status(403).json(flagBody(r.flagged))
    if (!owned) return res.status(403).json({ code: 'DENIED', error: 'Access denied. This document is not linked to your account.' })

    const info = { doc_ref: doc.doc_ref, doc_type: doc.doc_type, title: doc.title }
    if (action === 'download') {
      const content = [
        'DigiLocker (prototype) document',
        `Title   : ${doc.title}`,
        `Type    : ${doc.doc_type}`,
        `Doc ID  : ${doc.doc_ref}`,
        `Issued to: ${user.full_name}`,
        `Downloaded: ${new Date().toISOString()}`,
      ].join('\n')
      return res.json({ ok: true, doc: info, filename: `${doc.doc_type}_${doc.doc_ref}.txt`, content })
    }
    if (action === 'share') return res.json({ ok: true, doc: info, message: `${doc.title} shared with ${String(req.body.recipient).trim()}` })
    res.json({ ok: true, doc: info, message: `${doc.title} fetched from issuer` })
  })

router.post('/fetch', handler('fetch', 'DOCUMENT_FETCH'))
router.post('/download', handler('download', 'DOCUMENT_DOWNLOAD'))
router.post('/share', handler('share', 'DOCUMENT_SHARE'))
