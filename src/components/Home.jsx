import { useEffect, useState } from 'react'
import './Home.css'
import { api, apiGet } from './api'
import { getDeviceId, resetDeviceId } from './identity'

const ACTIONS = [
  { key: 'fetch', icon: '🔍', title: 'Fetch Document', desc: 'Pull a document from its issuer using the document ID' },
  { key: 'download', icon: '⬇️', title: 'Download Document', desc: 'Save a copy of a document to this device' },
  { key: 'share', icon: '🔗', title: 'Share Document', desc: 'Share a document with a person or organisation' },
]
const LABEL = { fetch: 'Fetched', download: 'Downloaded', share: 'Shared' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const saveFile = (name, content) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export default function Home({ user, onLogout }) {
  const [docs, setDocs] = useState([])
  const [action, setAction] = useState(null)
  const [selected, setSelected] = useState('')
  const [manualId, setManualId] = useState('')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [demo, setDemo] = useState('')
  const [message, setMessage] = useState(null) // { ok, text }
  const [activity, setActivity] = useState([])

  useEffect(() => {
    apiGet('/docs')
      .then((d) => { setDocs(d.documents); setSelected(d.documents[0]?.doc_ref || '') })
      .catch(() => {}) // flagged / expired sessions are handled globally by api.js
  }, [])

  const log = (ok, text) =>
    setActivity((a) => [{ id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), ok, text }, ...a].slice(0, 8))

  // throws on error so loops can stop; used by the buttons and the demo tools
  const perform = async (act, docRef, extra = {}, { silent = false } = {}) => {
    try {
      const data = await api(`/docs/${act}`, { docRef, ...extra })
      if (act === 'download' && !silent) saveFile(data.filename, data.content)
      log(true, `${LABEL[act]} ${data.doc.title} (${docRef})`)
      return data
    } catch (e) {
      if (e.code !== 'FLAGGED') log(false, `${act} ${docRef}: ${e.message}`)
      throw e
    }
  }

  const submit = async () => {
    const docRef = (manualId.trim() || selected).trim()
    setBusy(true)
    setMessage(null)
    try {
      const data = await perform(action, docRef, action === 'share' ? { recipient } : {})
      setMessage({ ok: true, text: data.message || `${data.doc.title} downloaded` })
    } catch (e) {
      if (e.code !== 'FLAGGED') setMessage({ ok: false, text: e.message })
    } finally {
      setBusy(false)
    }
  }

  /* ---- prototype-only attack simulators ---- */
  const bulkDownload = async () => {
    if (!docs.length) return
    setDemo('bulk')
    setMessage(null)
    try {
      for (let i = 0; i < 25; i++) {
        await perform('download', docs[i % docs.length].doc_ref, {}, { silent: true })
        await sleep(80)
      }
    } catch { /* stops when the account is flagged */ }
    setDemo('')
  }

  const probeIds = async () => {
    setDemo('probe')
    setMessage(null)
    try {
      for (let i = 0; i < 6; i++) {
        const fake = 'doc_' + Math.floor(10000 + Math.random() * 89999)
        try { await perform('fetch', fake) } catch (e) { if (e.code === 'FLAGGED') throw e }
        await sleep(120)
      }
    } catch { /* flagged */ }
    setDemo('')
  }

  const newDevice = () => {
    resetDeviceId()
    onLogout()
  }

  return (
    <div className="Home">
      <div className="Home__govbar">
        <span>🇮🇳 Government of India</span>
        <span>English ▾</span>
      </div>
      <header className="Home__header">
        <div className="Home__logo">
          <div className="Home__logo-mark">☁</div>
          <div className="Home__logo-name">DigiLocker</div>
        </div>
        <div className="Home__right">
          <a className="Home__link" href="#/dashboard">Monitoring dashboard</a>
          <div className="Home__user">
            <div className="Home__avatar">{user.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</div>
            <span>{user.name}</span>
          </div>
          <button className="Home__logout" onClick={onLogout}>Logout</button>
        </div>
      </header>

      <main className="Home__main">
        <h1>Welcome, {user.name.split(' ')[0]}</h1>
        <p className="Home__sub">What would you like to do today?</p>

        <div className="Home__actions">
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              className={`Home__action ${action === a.key ? 'is-active' : ''}`}
              onClick={() => { setAction(a.key); setMessage(null) }}
            >
              <span className="Home__action-icon">{a.icon}</span>
              <strong>{a.title}</strong>
              <span>{a.desc}</span>
            </button>
          ))}
        </div>

        {action && (
          <section className="Home__panel">
            <h2>{ACTIONS.find((a) => a.key === action).title}</h2>
            <label>Choose from your documents</label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {docs.map((d) => <option key={d.doc_ref} value={d.doc_ref}>{d.title} ({d.doc_ref})</option>)}
            </select>
            <label>Or enter a document ID</label>
            <input placeholder="doc_12345" value={manualId} onChange={(e) => setManualId(e.target.value)} />
            {action === 'share' && (
              <>
                <label>Share with</label>
                <input placeholder="Mobile number or email" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
              </>
            )}
            <button className="Home__submit" disabled={busy} onClick={submit}>
              {busy ? 'Please wait...' : ACTIONS.find((a) => a.key === action).title}
            </button>
            {message && <p className={message.ok ? 'Home__ok' : 'Home__bad'}>{message.text}</p>}
          </section>
        )}

        <div className="Home__grid">
          <section className="Home__card">
            <h3>My issued documents</h3>
            {docs.map((d) => (
              <div className="Home__doc" key={d.doc_ref}>
                <span>{d.title}</span>
                <code>{d.doc_ref}</code>
              </div>
            ))}
          </section>

          <section className="Home__card">
            <h3>Recent activity</h3>
            {activity.length === 0 && <p className="Home__muted">Nothing yet. Every click here is logged and checked against the fraud rules.</p>}
            {activity.map((a) => (
              <div className={`Home__act ${a.ok ? '' : 'is-bad'}`} key={a.id}>
                <span>{a.ok ? '✔' : '✖'}</span>
                <div>{a.text}<small>{a.time}</small></div>
              </div>
            ))}
          </section>
        </div>

        <section className="Home__card Home__demo">
          <h3>Prototype tools <span>(simulate suspicious behaviour)</span></h3>
          <div className="Home__demo-row">
            <button disabled={!!demo} onClick={bulkDownload}>{demo === 'bulk' ? 'Downloading...' : 'Download 25 documents fast'}</button>
            <button disabled={!!demo} onClick={probeIds}>{demo === 'probe' ? 'Probing...' : 'Fetch 6 random document IDs'}</button>
            <button disabled={!!demo} onClick={newDevice}>Logout and use a new device</button>
          </div>
          <p className="Home__muted">Device ID: {getDeviceId()}</p>
        </section>
      </main>
    </div>
  )
}
