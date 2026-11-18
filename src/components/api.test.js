// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api, apiGet } from './api'
import { API_BASE } from './config'

const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('api()', () => {
  it('POSTs JSON to the API with session and device headers', async () => {
    fetch.mockReturnValueOnce(reply(200, { ok: true }))
    const data = await api('/auth/check-mobile', { mobile: '9876543210' })

    expect(data).toEqual({ ok: true })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`${API_BASE}/auth/check-mobile`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ mobile: '9876543210' }))
    expect(init.headers['X-Session-Id']).toMatch(/^sess_/)
    expect(init.headers['X-Device-Id']).toMatch(/^device_/)
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('adds the bearer token when signed in', async () => {
    localStorage.setItem('dl_token', 'abc.def.ghi')
    fetch.mockReturnValueOnce(reply(200, {}))
    await api('/docs/fetch', { docRef: 'doc_1' })
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer abc.def.ghi')
  })

  it('apiGet sends a GET without a body', async () => {
    fetch.mockReturnValueOnce(reply(200, { documents: [] }))
    await apiGet('/docs')
    const init = fetch.mock.calls[0][1]
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it('throws an Error carrying the server message, status and code', async () => {
    fetch.mockReturnValueOnce(reply(403, { code: 'DENIED', error: 'Access denied. This document is not linked to your account.' }))
    await expect(api('/docs/fetch', { docRef: 'doc_9' })).rejects.toMatchObject({
      message: 'Access denied. This document is not linked to your account.',
      status: 403,
      code: 'DENIED',
    })
  })

  it('falls back to a generic message when the body is not JSON', async () => {
    fetch.mockReturnValueOnce(Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('bad json')) }))
    await expect(api('/x', {})).rejects.toMatchObject({ message: 'Something went wrong', status: 502 })
  })

  it('tells the app when a signed-in user gets flagged', async () => {
    localStorage.setItem('dl_token', 't')
    const flagged = vi.fn()
    window.addEventListener('dl:flagged', flagged)
    const body = { code: 'FLAGGED', error: 'flagged', rules: [{ id: 'R5', name: 'Sudden bulk downloads' }] }
    fetch.mockReturnValueOnce(reply(403, body))

    await expect(api('/docs/download', { docRef: 'doc_1' })).rejects.toBeTruthy()
    expect(flagged).toHaveBeenCalledTimes(1)
    expect(flagged.mock.calls[0][0].detail).toEqual(body)
    window.removeEventListener('dl:flagged', flagged)
  })

  it('does not fire the flagged event during login (no token yet)', async () => {
    const flagged = vi.fn()
    window.addEventListener('dl:flagged', flagged)
    fetch.mockReturnValueOnce(reply(423, { code: 'FLAGGED', error: 'flagged' }))

    await expect(api('/auth/verify-pin', {})).rejects.toMatchObject({ code: 'FLAGGED' })
    expect(flagged).not.toHaveBeenCalled()
    window.removeEventListener('dl:flagged', flagged)
  })

  it('signals an expired session on 401 when a token exists', async () => {
    localStorage.setItem('dl_token', 't')
    const expired = vi.fn()
    window.addEventListener('dl:unauthorized', expired)
    fetch.mockReturnValueOnce(reply(401, { error: 'Session expired, please login again' }))

    await expect(apiGet('/docs')).rejects.toBeTruthy()
    expect(expired).toHaveBeenCalledTimes(1)
    window.removeEventListener('dl:unauthorized', expired)
  })
})
