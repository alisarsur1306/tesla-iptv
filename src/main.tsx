import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LocaleProvider from './components/LocaleProvider.tsx'
import { initAccessKeyFromUrl } from './lib/xtream'

initAccessKeyFromUrl()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
    // Older Tesla browsers or disabled storage retain normal online behavior.
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider><App /></LocaleProvider>
  </StrictMode>,
)
