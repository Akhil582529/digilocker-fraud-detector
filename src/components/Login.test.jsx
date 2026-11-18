// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import Login from './Login'
import { api } from './api'

vi.mock('./api', () => ({ api: vi.fn() }))

const PROFILE = { maskedName: 'D**o U**r', initials: 'DU' }
const apiError = (message, extra = {}) => Object.assign(new Error(message), extra)

const typeMobile = (v) => fireEvent.change(screen.getByPlaceholderText('Mobile number'), { target: { value: v } })
const typeCode = (v) => fireEvent.change(document.querySelector('.Code__hidden'), { target: { value: v } })
const click = (name) => fireEvent.click(screen.getByRole('button', { name }))

async function reachPinScreen(onLogin = vi.fn()) {
  api.mockResolvedValueOnce({ exists: true, profile: PROFILE })
  render(<Login onLogin={onLogin} />)
  typeMobile('9876543210')
  click('Continue')
  await screen.findByText('Enter 6 digit security PIN')
  return onLogin
}

const flag = (over = {}) => ({
  code: 'FLAGGED', scope: 'user', kycAllowed: true,
  blockedUntil: new Date(Date.now() + 20 * 60000).toISOString(),
  rules: [{ id: 'R1', name: 'Repeated failed logins' }],
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  api.mockReset()
})
afterEach(cleanup)

describe('Login: mobile step', () => {
  it('keeps Continue disabled until a valid mobile number is typed', () => {
    render(<Login onLogin={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Continue' })
    expect(btn.disabled).toBe(true)
    typeMobile('1234567890') // must start with 6 to 9
    expect(btn.disabled).toBe(true)
    typeMobile('98765')
    expect(btn.disabled).toBe(true)
    typeMobile('9876543210')
    expect(btn.disabled).toBe(false)
  })

  it('strips non digits from the mobile field', () => {
    render(<Login onLogin={vi.fn()} />)
    typeMobile('98a76-54')
    expect(screen.getByPlaceholderText('Mobile number').value).toBe('987654')
  })

  it('shows the device id used for the logs', () => {
    render(<Login onLogin={vi.fn()} />)
    expect(screen.getByText(/This device: device_/)).toBeTruthy()
  })
})

describe('Login: routing between steps', () => {
  it('goes to the PIN screen when the mobile is registered', async () => {
    await reachPinScreen()
    expect(api).toHaveBeenCalledWith('/auth/check-mobile', { mobile: '9876543210' })
    expect(screen.getByText('D**o U**r')).toBeTruthy()
  })

  it('asks for Aadhaar when the mobile is not registered', async () => {
    api.mockResolvedValueOnce({ exists: false })
    render(<Login onLogin={vi.fn()} />)
    typeMobile('9123456789')
    click('Continue')
    expect(await screen.findByText('Enter Aadhaar number')).toBeTruthy()
  })

  it('moves from Aadhaar to the PIN screen when the account exists', async () => {
    api.mockResolvedValueOnce({ exists: false }).mockResolvedValueOnce({ exists: true, profile: PROFILE })
    render(<Login onLogin={vi.fn()} />)
    typeMobile('9123456789')
    click('Continue')
    await screen.findByText('Enter Aadhaar number')
    fireEvent.change(screen.getByPlaceholderText('12 digit Aadhaar number'), { target: { value: '200000000001' } })
    click('Continue')
    expect(await screen.findByText('Enter 6 digit security PIN')).toBeTruthy()
    expect(api).toHaveBeenLastCalledWith('/auth/check-aadhaar', { aadhaar: '200000000001' })
  })

  it('shows an error when the Aadhaar number has no account', async () => {
    api.mockResolvedValueOnce({ exists: false }).mockResolvedValueOnce({ exists: false })
    render(<Login onLogin={vi.fn()} />)
    typeMobile('9123456789')
    click('Continue')
    await screen.findByText('Enter Aadhaar number')
    fireEvent.change(screen.getByPlaceholderText('12 digit Aadhaar number'), { target: { value: '200000000999' } })
    click('Continue')
    expect(await screen.findByText('No account found with this Aadhaar number')).toBeTruthy()
  })
})

describe('Login: PIN step', () => {
  it('keeps Verify disabled until 6 digits are entered', async () => {
    await reachPinScreen()
    const verify = screen.getByRole('button', { name: 'Verify' })
    expect(verify.disabled).toBe(true)
    typeCode('123')
    expect(verify.disabled).toBe(true)
    typeCode('123456')
    expect(verify.disabled).toBe(false)
  })

  it('calls onLogin with the server response on success', async () => {
    const onLogin = await reachPinScreen()
    const session = { token: 'jwt', user: { name: 'Demo User One', ref: 'usr_0001' } }
    api.mockResolvedValueOnce(session)
    typeCode('123456')
    click('Verify')
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith(session))
    expect(api).toHaveBeenLastCalledWith('/auth/verify-pin', { identifier: { type: 'mobile', value: '9876543210' }, pin: '123456' })
  })

  it('shows the server message for a wrong PIN and does not log in', async () => {
    const onLogin = await reachPinScreen()
    api.mockRejectedValueOnce(apiError('Incorrect PIN. 3 attempts left before your account is temporarily blocked.', { status: 401 }))
    typeCode('000000')
    click('Verify')
    expect(await screen.findByText(/3 attempts left/)).toBeTruthy()
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('opens the flagged screen when the server flags the account', async () => {
    await reachPinScreen()
    api.mockRejectedValueOnce(apiError('flagged', { status: 423, code: 'FLAGGED', data: flag() }))
    typeCode('000000')
    click('Verify')
    expect(await screen.findByText('Your account is flagged')).toBeTruthy()
    expect(screen.getByText('Repeated failed logins')).toBeTruthy()
  })

  it('offers the forgot PIN flow', async () => {
    await reachPinScreen()
    click('Forgot security PIN?')
    expect(await screen.findByText('Recover your Account')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Verify' }).disabled).toBe(true) // needs a full date of birth
  })
})

describe('Login: flagged screen', () => {
  it('shows a 20 minute countdown and the matched rules', () => {
    render(<Login onLogin={vi.fn()} initialFlag={flag({ rules: [{ id: 'R4', name: 'Multiple document identifiers' }, { id: 'R8', name: 'Unauthorized access' }] })} />)
    expect(screen.getByText('Your account is flagged')).toBeTruthy()
    expect(screen.getByText(/^(19|20):\d{2}$/)).toBeTruthy()
    expect(screen.getByText('Multiple document identifiers')).toBeTruthy()
    expect(screen.getByText('Unauthorized access')).toBeTruthy()
  })

  it('offers Self KYC when it is allowed', () => {
    render(<Login onLogin={vi.fn()} initialFlag={flag()} />)
    expect(screen.getByRole('button', { name: 'Verify with Self KYC' })).toBeTruthy()
  })

  it('hides Self KYC after an OTP rule flag', () => {
    render(<Login onLogin={vi.fn()} initialFlag={flag({ kycAllowed: false, rules: [{ id: 'R2', name: 'Wrong OTP entries' }] })} />)
    expect(screen.queryByRole('button', { name: 'Verify with Self KYC' })).toBeNull()
  })

  it('describes a flagged device differently from a flagged account', () => {
    render(<Login onLogin={vi.fn()} initialFlag={flag({ scope: 'device', kycAllowed: false, rules: [{ id: 'R6', name: 'Many accounts from one device' }] })} />)
    expect(screen.getByText('This device is flagged')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Verify with Self KYC' })).toBeNull()
  })

  it('lets the user go back to login once the block has expired', () => {
    render(<Login onLogin={vi.fn()} initialFlag={flag({ blockedUntil: new Date(Date.now() - 1000).toISOString() })} />)
    click('Back to login')
    expect(screen.getByText('Login or Create Account')).toBeTruthy()
  })
})

describe('Login: Self KYC', () => {
  async function openKyc() {
    render(<Login onLogin={vi.fn()} initialFlag={flag()} />)
    click('Verify with Self KYC')
    await screen.findByText('Self KYC')
  }

  it('asks for Aadhaar, sends an OTP, then logs in', async () => {
    const onLogin = vi.fn()
    render(<Login onLogin={onLogin} initialFlag={flag()} />)
    click('Verify with Self KYC')
    await screen.findByText('Self KYC')

    api.mockResolvedValueOnce({ ok: true, mobileMasked: '******0001', resendIn: 10 })
    fireEvent.change(screen.getByPlaceholderText('12 digit Aadhaar number'), { target: { value: '200000000001' } })
    click('Send OTP')
    expect(await screen.findByText(/\*{6}0001/)).toBeTruthy()
    expect(api).toHaveBeenLastCalledWith('/auth/kyc/start', { aadhaar: '200000000001' })

    const session = { token: 'jwt', user: { name: 'Aarav Sharma', ref: 'usr_0001' } }
    api.mockResolvedValueOnce(session)
    typeCode('482913')
    click('Verify & Login')
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith(session))
    expect(api).toHaveBeenLastCalledWith('/auth/kyc/verify', { aadhaar: '200000000001', otp: '482913' })
  })

  it('keeps Send OTP disabled until the Aadhaar number is complete', async () => {
    await openKyc()
    expect(screen.getByRole('button', { name: 'Send OTP' }).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('12 digit Aadhaar number'), { target: { value: '2000' } })
    expect(screen.getByRole('button', { name: 'Send OTP' }).disabled).toBe(true)
  })

  it('shows the server error for a wrong OTP', async () => {
    await openKyc()
    api.mockResolvedValueOnce({ ok: true, mobileMasked: '******0001', resendIn: 10 })
    fireEvent.change(screen.getByPlaceholderText('12 digit Aadhaar number'), { target: { value: '200000000001' } })
    click('Send OTP')
    await screen.findByText(/\*{6}0001/)

    api.mockRejectedValueOnce(apiError('Incorrect or expired OTP. 4 attempts left before your account is temporarily blocked.', { status: 400 }))
    typeCode('000000')
    click('Verify & Login')
    expect(await screen.findByText(/4 attempts left/)).toBeTruthy()
  })
})

describe('Login: demo OTP banner (hosted demo only)', () => {
  async function toKycOtp(startResponse) {
    render(<Login onLogin={vi.fn()} initialFlag={flag()} />)
    click('Verify with Self KYC')
    await screen.findByText('Self KYC')
    api.mockResolvedValueOnce(startResponse)
    fireEvent.change(screen.getByPlaceholderText('12 digit Aadhaar number'), { target: { value: '200000000001' } })
    click('Send OTP')
    await screen.findByText(/\*{6}0001/)
  }

  it('shows the OTP on screen when the server sends it', async () => {
    await toKycOtp({ ok: true, mobileMasked: '******0001', resendIn: 10, demoOtp: '482913' })
    expect(screen.getByText(/Demo SMS: your OTP is/)).toBeTruthy()
    expect(screen.getByText('482913')).toBeTruthy()
  })

  it('shows nothing extra when the server does not send an OTP (normal mode)', async () => {
    await toKycOtp({ ok: true, mobileMasked: '******0001', resendIn: 10 })
    expect(screen.queryByText(/Demo SMS/)).toBeNull()
  })
})
