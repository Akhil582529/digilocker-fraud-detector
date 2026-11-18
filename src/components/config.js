// Local dev falls back to the API on port 5001.
// Hosted builds set VITE_API_BASE:
//   '/api'                                 when the API serves the frontend itself (Docker / Render)
//   'https://your-api.onrender.com/api'    when the frontend is on Vercel and the API is elsewhere
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5001/api'
