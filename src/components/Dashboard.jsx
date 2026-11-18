import { useCallback, useEffect, useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import './Dashboard.css'
import { api, apiGet } from './api'
import { API_BASE } from './config'

const RANGES = [['15m', 'Last 15 min'], ['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days']]
const RULE_COLORS = ['#7c6cf0', '#f43f5e', '#f59e0b', '#06b6d4', '#22c55e', '#ec4899', '#ef4444', '#3b82f6']
const SEV_COLORS = { medium: '#f59e0b', high: '#fb7185', critical: '#ef4444' }
const AXIS = '#8b93b8'
const TIP = { background: '#10132b', border: '1px solid #2c3160', borderRadius: 8, color: '#e8ebff', fontSize: 12 }

const secsLeft = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000))
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const describe = (e) => {
  switch (e.event_category) {
    case 'LOGIN':
      if (e.login_result === 'success') return 'Login success'
      if (e.login_result === 'blocked') return 'Login blocked (flagged)'
      return 'Login failed'
    case 'OTP':
      return e.otp_event_type === 'SEND' ? 'OTP sent' : e.otp_verification_result === 'success' ? 'OTP verified' : 'Wrong OTP'
    case 'ACCOUNT_RECOVERY': return 'Account recovery'
    case 'DOCUMENT_FETCH': return e.ownership_check_result === 'mismatch' ? 'Fetch denied (not owner)' : 'Document fetch'
    case 'DOCUMENT_DOWNLOAD': return 'Document download'
    case 'DOCUMENT_SHARE': return 'Document share'
    default: return e.event_category
  }
}
const bad = (e) => e.response_action === 'deny' || e.login_result === 'failure' || e.otp_verification_result === 'failure'

const Kpi = ({ label, value, color, hint }) => (
  <div className="Dash__kpi" style={{ '--c': color }}>
    <div className="Dash__kpi-value">{value}</div>
    <div className="Dash__kpi-label">{label}</div>
    {hint && <div className="Dash__kpi-hint">{hint}</div>}
  </div>
)

export default function Dashboard() {
  const [range, setRange] = useState('1h')
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [live, setLive] = useState(false)
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    try {
      setData(await apiGet(`/dashboard/summary?range=${range}`))
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }, [range])

  useEffect(() => { load() }, [load])

  // live updates: server pings us whenever an event or alert is stored
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/dashboard/stream`)
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.onmessage = () => load()
    return () => es.close()
  }, [load])

  useEffect(() => {
    const poll = setInterval(load, 10000)
    const tick = setInterval(() => setTick((x) => x + 1), 1000) // drives the countdowns
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [load])

  const unblock = async (type, ref) => {
    await api('/dashboard/unblock', { type, ref })
    load()
  }

  if (!data) {
    return <div className="Dash Dash--center">{err ? `Cannot reach the API: ${err}` : 'Loading dashboard...'}</div>
  }

  const k = data.kpis
  const long = range === '24h' || range === '7d'
  const tickFmt = (t) =>
    new Date(t).toLocaleString([], long ? { month: 'short', day: 'numeric', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
  const timeline = data.timeline

  const loginPie = [
    { name: 'Success', value: k.logins_success, color: '#22c55e' },
    { name: 'Failed', value: k.logins_failed, color: '#f43f5e' },
    { name: 'Blocked', value: k.logins_blocked, color: '#f59e0b' },
  ].filter((d) => d.value > 0)
  const rulePie = data.rules.map((r, i) => ({ name: r.id, full: r.name, hits: r.hits, color: RULE_COLORS[i] }))
  const sevPie = data.severity.map((s) => ({ name: s.severity, value: s.count, color: SEV_COLORS[s.severity] || '#7c6cf0' }))
  const maxHits = Math.max(1, ...data.rules.map((r) => r.hits))

  return (
    <div className="Dash">
      <header className="Dash__header">
        <div>
          <h1>Fraud &amp; Risk Monitoring</h1>
          <p>DigiLocker login and document activity, checked against 8 detection rules</p>
        </div>
        <div className="Dash__controls">
          <span className={`Dash__live ${live ? 'is-live' : ''}`}><i /> {live ? 'Live' : 'Reconnecting...'}</span>
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <a href="#/">← Back to app</a>
        </div>
      </header>

      <section className="Dash__kpis">
        <Kpi label="Users logged in" value={k.users_logged_in} color="#22c55e" hint={`${k.logins_success} successful logins`} />
        <Kpi label="Failed logins" value={k.logins_failed} color="#f43f5e" hint={`${k.logins_blocked} blocked attempts`} />
        <Kpi label="Alerts raised" value={k.alerts} color="#a78bfa" hint={`${k.flagged_users} users, ${k.flagged_devices} devices`} />
        <Kpi label="Blocked right now" value={k.blocked_now} color="#ef4444" hint={`${data.blockMinutes} min blocks`} />
        <Kpi label="Downloads" value={k.downloads} color="#38bdf8" hint={`${k.fetches} fetches, ${k.shares} shares`} />
        <Kpi label="OTPs sent" value={k.otp_sent} color="#f59e0b" hint={`${k.otp_failed} wrong OTP entries`} />
      </section>

      <section className="Dash__row Dash__row--2-1">
        <div className="Dash__card">
          <h3>Activity over time</h3>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={timeline} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <defs>
                {[['gLogin', '#22c55e'], ['gFail', '#f43f5e'], ['gOtp', '#f59e0b'], ['gDoc', '#38bdf8']].map(([id, c]) => (
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={c} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={c} stopOpacity={0.05} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke="#262a52" strokeDasharray="3 3" />
              <XAxis dataKey="t" tickFormatter={tickFmt} stroke={AXIS} fontSize={11} />
              <YAxis stroke={AXIS} fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={TIP} labelFormatter={tickFmt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="login_success" name="Login success" stackId="1" stroke="#22c55e" fill="url(#gLogin)" />
              <Area type="monotone" dataKey="login_failed" name="Login failed" stackId="1" stroke="#f43f5e" fill="url(#gFail)" />
              <Area type="monotone" dataKey="otp" name="OTP" stackId="1" stroke="#f59e0b" fill="url(#gOtp)" />
              <Area type="monotone" dataKey="documents" name="Documents" stackId="1" stroke="#38bdf8" fill="url(#gDoc)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="Dash__card">
          <h3>Login outcomes</h3>
          {loginPie.length === 0 ? <p className="Dash__empty">No logins in this range</p> : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={loginPie} dataKey="value" nameKey="name" innerRadius={62} outerRadius={98} paddingAngle={3} stroke="none">
                  {loginPie.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip contentStyle={TIP} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="Dash__row Dash__row--1-1-1">
        <div className="Dash__card">
          <h3>Alerts over time</h3>
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={timeline} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
              <CartesianGrid stroke="#262a52" strokeDasharray="3 3" />
              <XAxis dataKey="t" tickFormatter={tickFmt} stroke={AXIS} fontSize={11} />
              <YAxis stroke={AXIS} fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={TIP} labelFormatter={tickFmt} cursor={{ fill: '#ffffff10' }} />
              <Bar dataKey="alerts" name="Alerts" fill="#a78bfa" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="Dash__card">
          <h3>Alerts by rule</h3>
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={rulePie} layout="vertical" margin={{ top: 4, right: 12, left: -6, bottom: 0 }}>
              <CartesianGrid stroke="#262a52" strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" stroke={AXIS} fontSize={11} allowDecimals={false} />
              <YAxis type="category" dataKey="name" stroke={AXIS} fontSize={12} width={36} />
              <Tooltip contentStyle={TIP} cursor={{ fill: '#ffffff10' }} formatter={(v, n, p) => [v, p.payload.full]} />
              <Bar dataKey="hits" radius={[0, 4, 4, 0]}>
                {rulePie.map((d) => <Cell key={d.name} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="Dash__card">
          <h3>Alert severity</h3>
          {sevPie.length === 0 ? <p className="Dash__empty">No alerts in this range</p> : (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={sevPie} dataKey="value" nameKey="name" outerRadius={86} stroke="none" label={({ name, value }) => `${name} ${value}`}>
                  {sevPie.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip contentStyle={TIP} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="Dash__row Dash__row--1-1">
        <div className="Dash__card">
          <h3>Blocked right now <span className="Dash__badge">{data.blockedNow.length}</span></h3>
          {data.blockedNow.length === 0 && <p className="Dash__empty">Nobody is blocked</p>}
          {data.blockedNow.map((b) => (
            <div className="Dash__blocked" key={b.type + b.ref}>
              <div>
                <strong>{b.type === 'user' ? b.ref : b.ref}</strong>
                <small>{b.type}{b.mobile ? ` · ${b.mobile}` : ''}</small>
                <div className="Dash__tags">{b.rules.map((r) => <span key={r.id} title={r.name}>{r.id}</span>)}</div>
              </div>
              <div className="Dash__blocked-right">
                <b>{mmss(secsLeft(b.blocked_until))}</b>
                <button onClick={() => unblock(b.type, b.ref)}>Unblock</button>
              </div>
            </div>
          ))}
        </div>

        <div className="Dash__card">
          <h3>Recent alerts</h3>
          {data.recentAlerts.length === 0 && <p className="Dash__empty">No alerts yet</p>}
          <div className="Dash__list">
            {data.recentAlerts.map((a) => (
              <div className="Dash__alert" key={a.id}>
                <span className="Dash__sev" style={{ background: SEV_COLORS[a.severity] }}>{a.rule_id}</span>
                <div>
                  <strong>{a.rule_name}</strong>
                  <small>{a.subject_type === 'user' ? a.user_ref : a.device_ref} · {clock(a.created_at)}</small>
                </div>
                <em style={{ color: SEV_COLORS[a.severity] }}>{a.severity}</em>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="Dash__row Dash__row--1-1">
        <div className="Dash__card">
          <h3>Live event feed</h3>
          <div className="Dash__list">
            {data.feed.map((e) => (
              <div className={`Dash__event ${bad(e) ? 'is-bad' : ''}`} key={e.event_id}>
                <time>{clock(e.event_time)}</time>
                <span>{describe(e)}</span>
                <small>{e.user_ref || e.attempted_ref || '-'}</small>
                {e.rule_triggered_ref && <b>{e.rule_triggered_ref}</b>}
              </div>
            ))}
          </div>
        </div>

        <div className="Dash__card">
          <h3>Devices by accounts attempted</h3>
          <table className="Dash__table">
            <thead><tr><th>Device</th><th>Accounts</th><th>Failures</th><th>Last seen</th></tr></thead>
            <tbody>
              {data.devices.map((d) => (
                <tr key={d.device_ref} className={d.accounts >= 10 ? 'is-hot' : ''}>
                  <td>{d.device_ref}</td><td>{d.accounts}</td><td>{d.failures}</td><td>{clock(d.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="Dash__card Dash__rules">
        <h3>Detection rules</h3>
        <table className="Dash__table">
          <thead><tr><th>Rule</th><th>What it checks</th><th>Scope</th><th>Severity</th><th>Alerts</th></tr></thead>
          <tbody>
            {data.rules.map((r, i) => (
              <tr key={r.id}>
                <td><span className="Dash__rid" style={{ background: RULE_COLORS[i] }}>{r.id}</span> {r.name}</td>
                <td>{r.text}</td>
                <td>{r.scope}</td>
                <td style={{ color: SEV_COLORS[r.severity] }}>{r.severity}</td>
                <td>
                  <div className="Dash__bar"><i style={{ width: `${(r.hits / maxHits) * 100}%`, background: RULE_COLORS[i] }} /></div>
                  {r.hits}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
