import { API_BASE } from './config'
import { getSessionId, getDeviceId } from './identity'

export async function api(path, body, { method = 'POST' } = {}) {
  const token = localStorage.getItem('dl_token')
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': getSessionId(),
      'X-Device-Id': getDeviceId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  })
  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    // signed-in user just got flagged / session died: tell the app so it can log them out
    if (token && data.code === 'FLAGGED') window.dispatchEvent(new CustomEvent('dl:flagged', { detail: data }))
    else if (token && res.status === 401) window.dispatchEvent(new Event('dl:unauthorized'))

    const err = new Error(data.error || 'Something went wrong')
    err.status = res.status
    err.code = data.code
    err.data = data
    throw err
  }
  return data
}

export const apiGet = (path) => api(path, null, { method: 'GET' })
