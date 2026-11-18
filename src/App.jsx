import { useCallback, useEffect, useState } from 'react'
import Login from './components/Login'
import Home from './components/Home'
import Dashboard from './components/Dashboard'

const readUser = () => {
  try { return JSON.parse(localStorage.getItem('dl_user')) } catch { return null }
}

function App() {
  const [route, setRoute] = useState(window.location.hash)
  const [user, setUser] = useState(() => (localStorage.getItem('dl_token') ? readUser() : null))
  const [flag, setFlag] = useState(null)

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('dl_token')
    localStorage.removeItem('dl_user')
    setUser(null)
  }, [])

  // api.js fires these when the server flags the signed-in user or the session expires
  useEffect(() => {
    const onFlagged = (e) => { logout(); setFlag(e.detail) }
    window.addEventListener('dl:flagged', onFlagged)
    window.addEventListener('dl:unauthorized', logout)
    return () => {
      window.removeEventListener('dl:flagged', onFlagged)
      window.removeEventListener('dl:unauthorized', logout)
    }
  }, [logout])

  const handleLogin = (data) => {
    localStorage.setItem('dl_token', data.token)
    localStorage.setItem('dl_user', JSON.stringify(data.user))
    setFlag(null)
    setUser(data.user)
  }

  if (route === '#/dashboard') return <Dashboard />
  if (user) return <Home user={user} onLogout={logout} />
  return <Login onLogin={handleLogin} initialFlag={flag} />
}

export default App
