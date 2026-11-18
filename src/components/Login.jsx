import React, { useEffect, useRef, useState } from 'react'
import './Login.css'
import { api } from './api'
import { getDeviceId, resetDeviceId } from './identity'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const THIS_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: 100 }, (_, i) => THIS_YEAR - i)
const pad = (n) => String(n).padStart(2, '0')
const fmtTime = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
const secsLeft = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000))

const EyeIcon = ({ off }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#5b3fe0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <line x1="3" y1="3" x2="21" y2="21" />}
  </svg>
)

/* 6 box PIN / OTP input, one hidden real input behind it */
const CodeInput = ({ value, onChange, onEnter }) => {
  const [show, setShow] = useState(false)
  const [focused, setFocused] = useState(true)
  const ref = useRef(null)

  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div className="Code" onClick={() => ref.current?.focus()}>
      <div className="Code__boxes">
        <input
          ref={ref}
          className="Code__hidden"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
        />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`Code__box ${focused && i === Math.min(value.length, 5) ? 'is-active' : ''}`}>
            {value[i] ? (show ? value[i] : '•') : ''}
          </div>
        ))}
      </div>
      <button type="button" className="Code__eye" onClick={(e) => { e.stopPropagation(); setShow((s) => !s) }} aria-label="Toggle visibility">
        <EyeIcon off={!show} />
      </button>
    </div>
  )
}

/* shown when a rule flagged the account or the device */
const Flagged = ({ flag, onKyc, onRetry }) => {
  const [left, setLeft] = useState(() => secsLeft(flag.blockedUntil))
  useEffect(() => {
    const t = setInterval(() => setLeft(secsLeft(flag.blockedUntil)), 1000)
    return () => clearInterval(t)
  }, [flag.blockedUntil])

  const isDevice = flag.scope === 'device'
  return (
    <div className="Login__flagged">
      <div className="Login__alert">!</div>
      <h1>{isDevice ? 'This device is flagged' : 'Your account is flagged'}</h1>
      <p className="Login__sub">
        We detected unusual activity and signed you out for security. You can try again in:
      </p>
      <div className="Login__countdown">{fmtTime(left)}</div>
      {flag.rules?.length > 0 && (
        <ul className="Login__reasons">
          {flag.rules.map((r) => <li key={r.id}><span>{r.id}</span>{r.name}</li>)}
        </ul>
      )}
      {flag.kycAllowed && (
        <>
          <button className="Login__btn" onClick={onKyc}>Verify with Self KYC</button>
          <p className="Login__hint Login__hint--center">Verify your Aadhaar and OTP to sign in again right away.</p>
        </>
      )}
      {left === 0 && <button className={flag.kycAllowed ? 'Login__link' : 'Login__btn'} onClick={onRetry}>Back to login</button>}
    </div>
  )
}

const Login = ({ onLogin, initialFlag }) => {
  // mobile | aadhaar | pin | forgot_dob | forgot_otp | reset_pin | flagged | kyc_aadhaar | kyc_otp
  const [step, setStep] = useState(initialFlag ? 'flagged' : 'mobile')
  const [flag, setFlag] = useState(initialFlag || null)
  const [mobile, setMobile] = useState('')
  const [aadhaar, setAadhaar] = useState('')
  const [kycAadhaar, setKycAadhaar] = useState('')
  const [identifier, setIdentifier] = useState(null)
  const [profile, setProfile] = useState(null)
  const [pin, setPin] = useState('')
  const [dob, setDob] = useState({ d: '', m: '', y: '' })
  const [otp, setOtp] = useState('')
  const [maskedMobile, setMaskedMobile] = useState('')
  const [demoOtp, setDemoOtp] = useState('') // only filled when the hosted demo has DEMO_SHOW_OTP=true
  const [cooldown, setCooldown] = useState(0)
  const [resetToken, setResetToken] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (initialFlag) { setFlag(initialFlag); setStep('flagged') }
  }, [initialFlag])

  // resend OTP countdown
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const goto = (s) => { setError(''); setStep(s) }

  const run = async (fn) => {
    setError('')
    setLoading(true)
    try {
      await fn()
    } catch (e) {
      if (e.code === 'FLAGGED') { setFlag(e.data); setStep('flagged') }
      else setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  /* ---- normal login ---- */
  const submitMobile = () => run(async () => {
    const data = await api('/auth/check-mobile', { mobile })
    if (data.exists) {
      setIdentifier({ type: 'mobile', value: mobile })
      setProfile(data.profile)
      setPin('')
      setNotice('')
      setStep('pin')
    } else {
      setStep('aadhaar') // number not registered -> ask Aadhaar
    }
  })

  const submitAadhaar = () => run(async () => {
    const data = await api('/auth/check-aadhaar', { aadhaar })
    if (!data.exists) throw new Error('No account found with this Aadhaar number')
    setIdentifier({ type: 'aadhaar', value: aadhaar })
    setProfile(data.profile)
    setPin('')
    setNotice('')
    setStep('pin')
  })

  const submitPin = () => run(async () => {
    try {
      const data = await api('/auth/verify-pin', { identifier, pin })
      onLogin(data)
    } catch (e) {
      setPin('')
      throw e
    }
  })

  /* ---- forgot PIN: DOB -> OTP -> new PIN ---- */
  const submitDob = () => run(async () => {
    const iso = `${dob.y}-${pad(dob.m)}-${pad(dob.d)}`
    const data = await api('/auth/forgot-pin/verify-dob', { identifier, dob: iso })
    setMaskedMobile(data.mobileMasked)
    setCooldown(data.resendIn)
    setDemoOtp(data.demoOtp || '')
    setOtp('')
    setStep('forgot_otp')
  })

  const resendOtp = () => run(async () => {
    const data = await api('/auth/forgot-pin/resend-otp', { identifier })
    setCooldown(data.resendIn)
    setDemoOtp(data.demoOtp || '')
    setOtp('')
  })

  const submitOtp = () => run(async () => {
    try {
      const data = await api('/auth/forgot-pin/verify-otp', { identifier, otp })
      setResetToken(data.resetToken)
      setNewPin('')
      setConfirmPin('')
      setStep('reset_pin')
    } catch (e) {
      setOtp('')
      throw e
    }
  })

  const submitReset = () => run(async () => {
    if (newPin !== confirmPin) throw new Error('PINs do not match')
    await api('/auth/forgot-pin/reset', { resetToken, newPin })
    setPin('')
    setNotice('PIN updated. Login with your new PIN.')
    setStep('pin')
  })

  /* ---- self KYC (way back in after a flag): Aadhaar -> OTP ---- */
  const startKyc = () => run(async () => {
    const data = await api('/auth/kyc/start', { aadhaar: kycAadhaar })
    setMaskedMobile(data.mobileMasked)
    setCooldown(data.resendIn)
    setDemoOtp(data.demoOtp || '')
    setOtp('')
    setStep('kyc_otp')
  })

  const resendKyc = () => run(async () => {
    const data = await api('/auth/kyc/start', { aadhaar: kycAadhaar })
    setCooldown(data.resendIn)
    setDemoOtp(data.demoOtp || '')
    setOtp('')
  })

  const verifyKyc = () => run(async () => {
    try {
      const data = await api('/auth/kyc/verify', { aadhaar: kycAadhaar, otp })
      onLogin(data)
    } catch (e) {
      setOtp('')
      throw e
    }
  })

  const dobComplete = dob.d && dob.m && dob.y

  const Profile = ({ back }) => (
    <div className="Login__profile">
      {back && <button className="Login__back" onClick={back} aria-label="Back">←</button>}
      <div className="Login__avatar">{profile?.initials}</div>
      <div>
        <div className="Login__pname">{profile?.maskedName}</div>
        <div className="Login__verified">Verified <span>✔</span></div>
      </div>
    </div>
  )

  const Resend = ({ onResend }) => (
    <p className="Login__resend">
      {cooldown > 0
        ? <>Resend OTP in &nbsp;{fmtTime(cooldown)}</>
        : <button className="Login__inline" onClick={onResend} disabled={loading}>Resend OTP</button>}
    </p>
  )

  return (
    <div className="Login">
      {/* top govt bar */}
      <div className="Login__govbar">
        <span>🇮🇳 Government of India</span>
        <span className="Login__govbar-right">Skip to main content &nbsp;|&nbsp; A+ &nbsp;A&nbsp; A- &nbsp;|&nbsp; English ▾</span>
      </div>

      <header className="Login__header">
        <div className="Login__logo">
          <div className="Login__logo-mark">☁</div>
          <div>
            <div className="Login__logo-name">DigiLocker</div>
            <div className="Login__logo-tag">Document Wallet to Empower Citizens</div>
          </div>
        </div>
        <a className="Login__admin" href="#/dashboard">Monitoring dashboard →</a>
      </header>

      <main className="Login__main">
        <div className="Login__card">

          {step === 'mobile' && (
            <>
              <h1>Login or Create Account</h1>
              <p className="Login__sub">Enter your mobile number to proceed</p>
              <div className="Login__field">
                <span className="Login__prefix">+91</span>
                <input
                  type="tel" inputMode="numeric" maxLength={10} autoFocus
                  placeholder="Mobile number" value={mobile}
                  onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && /^[6-9]\d{9}$/.test(mobile) && submitMobile()}
                />
              </div>
              {error && <p className="Login__error">{error}</p>}
              <button className="Login__btn" disabled={!/^[6-9]\d{9}$/.test(mobile) || loading} onClick={submitMobile}>
                {loading ? 'Please wait...' : 'Continue'}
              </button>
              <p className="Login__terms">By continuing, I agree to the <a href="#!">Terms of Service</a></p>
              <p className="Login__trouble">
                Facing trouble? <button className="Login__inline" onClick={() => goto('aadhaar')}>Try using Aadhaar or VID</button>
              </p>
              <button
                className="Login__demo"
                onClick={() => { const id = resetDeviceId(); setNotice(`Now pretending to be a new device (${id})`) }}
                title="Prototype only: creates a fresh device ID so the logs treat you as a new device"
              >
                Demo: simulate a new device
              </button>
              {notice && <p className="Login__demo-note">{notice}</p>}
              <p className="Login__demo-note">This device: {getDeviceId()}</p>
            </>
          )}

          {step === 'aadhaar' && (
            <>
              <h1>Enter Aadhaar number</h1>
              <p className="Login__sub">Use your Aadhaar number to find your account</p>
              <div className="Login__field">
                <input
                  className="Login__plain" type="tel" inputMode="numeric" maxLength={12} autoFocus
                  placeholder="12 digit Aadhaar number" value={aadhaar}
                  onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && aadhaar.length === 12 && submitAadhaar()}
                />
              </div>
              {error && <p className="Login__error">{error}</p>}
              <button className="Login__btn" disabled={aadhaar.length !== 12 || loading} onClick={submitAadhaar}>
                {loading ? 'Please wait...' : 'Continue'}
              </button>
              <button className="Login__link" onClick={() => goto('mobile')}>← Use mobile number instead</button>
            </>
          )}

          {step === 'pin' && (
            <>
              <Profile back={() => goto(identifier?.type === 'aadhaar' ? 'aadhaar' : 'mobile')} />
              <h2>Enter 6 digit security PIN</h2>
              {notice && <p className="Login__notice">{notice}</p>}
              <CodeInput value={pin} onChange={setPin} onEnter={() => pin.length === 6 && submitPin()} />
              {error && <p className="Login__error">{error}</p>}
              <button className="Login__inline Login__forgot" onClick={() => { setDob({ d: '', m: '', y: '' }); goto('forgot_dob') }}>
                Forgot security PIN?
              </button>
              <button className="Login__btn" disabled={pin.length !== 6 || loading} onClick={submitPin}>
                {loading ? 'Verifying...' : 'Verify'}
              </button>
            </>
          )}

          {step === 'forgot_dob' && (
            <>
              <Profile back={() => goto('pin')} />
              <h2>Recover your Account</h2>
              <p className="Login__sub Login__sub--tight">You will receive an OTP to verify your identity</p>
              <label className="Login__label">Date of Birth</label>
              <div className="Login__dob">
                <select value={dob.d} onChange={(e) => setDob({ ...dob, d: e.target.value })}>
                  <option value="">Day</option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <select value={dob.m} onChange={(e) => setDob({ ...dob, m: e.target.value })}>
                  <option value="">Month</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select value={dob.y} onChange={(e) => setDob({ ...dob, y: e.target.value })}>
                  <option value="">Year</option>
                  {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <p className="Login__hint">Please enter your date of birth as per your account</p>
              {error && <p className="Login__error">{error}</p>}
              <button className="Login__btn" disabled={!dobComplete || loading} onClick={submitDob}>
                {loading ? 'Please wait...' : 'Verify'}
              </button>
            </>
          )}

          {step === 'forgot_otp' && (
            <>
              <h2 className="Login__h2-top">Verify OTP</h2>
              <p className="Login__sub">Please enter One Time Password (OTP) sent on your mobile number ({maskedMobile})</p>
              {demoOtp && <p className="Login__demo-otp">Demo SMS: your OTP is <b>{demoOtp}</b></p>}
              <CodeInput value={otp} onChange={setOtp} onEnter={() => otp.length === 6 && submitOtp()} />
              {error && <p className="Login__error">{error}</p>}
              <Resend onResend={resendOtp} />
              <button className="Login__btn" disabled={otp.length !== 6 || loading} onClick={submitOtp}>
                {loading ? 'Verifying...' : 'Verify'}
              </button>
            </>
          )}

          {step === 'reset_pin' && (
            <>
              <h2 className="Login__h2-top">Set new security PIN</h2>
              <p className="Login__sub">Choose a 6 digit PIN you will remember</p>
              <label className="Login__label">New PIN</label>
              <CodeInput value={newPin} onChange={setNewPin} />
              <label className="Login__label Login__label--gap">Confirm PIN</label>
              <CodeInput value={confirmPin} onChange={setConfirmPin} onEnter={() => newPin.length === 6 && confirmPin.length === 6 && submitReset()} />
              {error && <p className="Login__error">{error}</p>}
              <button className="Login__btn" disabled={newPin.length !== 6 || confirmPin.length !== 6 || loading} onClick={submitReset}>
                {loading ? 'Saving...' : 'Update PIN'}
              </button>
            </>
          )}

          {step === 'flagged' && flag && (
            <Flagged
              flag={flag}
              onKyc={() => { setKycAadhaar(''); goto('kyc_aadhaar') }}
              onRetry={() => { setFlag(null); setMobile(''); goto('mobile') }}
            />
          )}

          {step === 'kyc_aadhaar' && (
            <>
              <h1>Self KYC</h1>
              <p className="Login__sub">Enter your Aadhaar number. We will send an OTP to your registered mobile.</p>
              <div className="Login__field">
                <input
                  className="Login__plain" type="tel" inputMode="numeric" maxLength={12} autoFocus
                  placeholder="12 digit Aadhaar number" value={kycAadhaar}
                  onChange={(e) => setKycAadhaar(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && kycAadhaar.length === 12 && startKyc()}
                />
              </div>
              {error && <p className="Login__error">{error}</p>}
              <button className="Login__btn" disabled={kycAadhaar.length !== 12 || loading} onClick={startKyc}>
                {loading ? 'Please wait...' : 'Send OTP'}
              </button>
              <button className="Login__link" onClick={() => goto('flagged')}>← Back</button>
            </>
          )}

          {step === 'kyc_otp' && (
            <>
              <h2 className="Login__h2-top">Verify OTP</h2>
              <p className="Login__sub">Please enter One Time Password (OTP) sent on your mobile number ({maskedMobile})</p>
              {demoOtp && <p className="Login__demo-otp">Demo SMS: your OTP is <b>{demoOtp}</b></p>}
              <CodeInput value={otp} onChange={setOtp} onEnter={() => otp.length === 6 && verifyKyc()} />
              {error && <p className="Login__error">{error}</p>}
              <Resend onResend={resendKyc} />
              <button className="Login__btn" disabled={otp.length !== 6 || loading} onClick={verifyKyc}>
                {loading ? 'Verifying...' : 'Verify & Login'}
              </button>
            </>
          )}
        </div>
      </main>

      <footer className="Login__footer">
        <div className="Login__footer-inner">
          <div>
            <div className="Login__footer-logo">DigiLocker</div>
            <p>DigiLocker aims at 'Digital Empowerment' by providing access to authentic digital documents to the citizen's digital document wallet.</p>
          </div>
          <div className="Login__footer-links">
            <a href="#!">Home</a><a href="#!">About Us</a><a href="#!">FAQ</a><a href="#!">Statistics</a>
          </div>
          <div className="Login__footer-links">
            <a href="#!">Support/Feedback</a><a href="#!">Terms &amp; Condition of Use</a><a href="#!">Video Guides</a><a href="#!">Credits</a>
          </div>
          <div className="Login__footer-right">
            <strong>National e-Governance Division (NeGD)</strong>
            <span>Digital India Corporation</span>
            <span>Ministry of Electronics &amp; IT (MeitY)</span>
            <span className="Login__footer-demo">Demo project, not affiliated with DigiLocker</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default Login
