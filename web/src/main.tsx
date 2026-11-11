import React from 'react'
import ReactDOM from 'react-dom/client'
import { Router } from 'wouter'
import App from './App'
import { appBasePath } from './lib/basePath'
import { prefetchSession } from './lib/sessionPrefetch'
import './styles/globals.css'

// Start the session fetch before React mounts — it is the critical path of the
// initial page load and boot would otherwise delay it by hundreds of ms.
const sessionMatch = window.location.pathname.match(/\/p\/[^/]+\/s\/([0-9a-fA-F-]+)/)
if (sessionMatch?.[1]) {
  prefetchSession(sessionMatch[1])
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Router base={appBasePath}>
      <App />
    </Router>
  </React.StrictMode>,
)
