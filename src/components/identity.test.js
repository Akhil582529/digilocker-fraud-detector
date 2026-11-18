// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { getSessionId, getDeviceId, resetDeviceId } from './identity'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('identity', () => {
  it('creates a device id once and keeps it', () => {
    const id = getDeviceId()
    expect(id).toMatch(/^device_[A-Za-z0-9]+$/)
    expect(getDeviceId()).toBe(id)
    expect(localStorage.getItem('dl_device')).toBe(id)
  })

  it('creates a session id once per tab', () => {
    const id = getSessionId()
    expect(id).toMatch(/^sess_[A-Za-z0-9]+$/)
    expect(getSessionId()).toBe(id)
  })

  it('resetDeviceId pretends to be a brand new device', () => {
    const before = getDeviceId()
    const after = resetDeviceId()
    expect(after).not.toBe(before)
    expect(getDeviceId()).toBe(after)
  })

  it('ids use only characters the server accepts', () => {
    expect(getDeviceId()).toMatch(/^[\w.-]{1,64}$/)
    expect(getSessionId()).toMatch(/^[\w.-]{1,64}$/)
  })
})
