// Los estilos globales primero: los de cada componente ganan en caso de empate.
import './styles/global.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { registerServiceWorker } from './pwa/registerServiceWorker'
import { initApp } from './state/store'

initApp()
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
