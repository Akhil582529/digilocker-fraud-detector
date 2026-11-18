// Session + device identifiers sent with every request (they become session_ref / device_ref in the logs)
const rnd = () =>
  (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 10)

export const getSessionId = () => {
  let id = sessionStorage.getItem('dl_session')
  if (!id) {
    id = 'sess_' + rnd()
    sessionStorage.setItem('dl_session', id)
  }
  return id
}

export const getDeviceId = () => {
  let id = localStorage.getItem('dl_device')
  if (!id) {
    id = 'device_' + rnd()
    localStorage.setItem('dl_device', id)
  }
  return id
}

// demo helper: pretend to be a brand new device
export const resetDeviceId = () => {
  localStorage.removeItem('dl_device')
  return getDeviceId()
}
