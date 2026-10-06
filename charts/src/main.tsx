import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { adoptDirectorPairing } from './lib/pairing'
import './styles/app.css'

void adoptDirectorPairing().catch(() => undefined).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
