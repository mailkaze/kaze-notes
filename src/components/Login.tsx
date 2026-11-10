import { backendError } from '../lib/backend'
import { t } from '../lib/i18n'
import { signIn, useApp } from '../state/store'

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  )
}

function Logo() {
  return <img src="/favicon.svg" width={56} height={56} alt="" />
}

export function LoginScreen() {
  const error = useApp((s) => s.sync.error)
  return (
    <div className="center-screen">
      <div className="login-card">
        <Logo />
        <h1>Kaze Notes</h1>
        <p>{t('Your notes, synced everywhere.', 'Tus notas, sincronizadas en todas partes.')}</p>
        <button type="button" className="btn" onClick={() => void signIn()}>
          <GoogleLogo />
          {t('Continue with Google', 'Continuar con Google')}
        </button>
        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  )
}

export function SetupScreen() {
  return (
    <div className="center-screen">
      <div className="login-card setup-card">
        <h1>{t('Firebase is not configured', 'Falta configurar Firebase')}</h1>
        <p>
          {t('Create a ', 'Crea un fichero ')}
          <code>.env.local</code>
          {t(' file from ', ' a partir de ')}
          <code>.env.example</code>
          {t(' with your Firebase web app values and restart the dev server.', ' con los valores de tu app web de Firebase y reinicia el servidor.')}
        </p>
        <p className="login-error">{backendError}</p>
      </div>
    </div>
  )
}

export function LoadingScreen() {
  return (
    <div className="center-screen">
      <div className="loader" role="progressbar" aria-label={t('Loading', 'Cargando')} />
    </div>
  )
}
