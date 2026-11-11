import { lazy, Suspense, useEffect, type CSSProperties } from 'react'
import { LoadingScreen, LoginScreen, SetupScreen } from './components/Login'
import { NotesScreen } from './components/notes/NotesScreen'
import { TrashScreen } from './components/notes/TrashScreen'
import { Sidebar } from './components/sidebar/Sidebar'
import { ConfirmHost, isConfirmOpen } from './components/ui/confirm'
import { chunkLoaded, ErrorBoundary } from './components/ui/ErrorBoundary'
import { FOCUS_SEARCH_EVENT } from './components/ui/controls'
import { backendError } from './lib/backend'
import { t } from './lib/i18n'
import type { ThemePref } from './lib/types'
import { UpdateBanner } from './pwa/UpdateBanner'
import { closeNote, openFolder, setFullscreen, setSidebarOpen, useApp } from './state/store'

// El editor (TipTap) va en un fichero aparte: la primera carga es más ligera.
const NoteEditor = lazy(() =>
  import('./components/editor/NoteEditor').then((m) => {
    chunkLoaded()
    return { default: m.NoteEditor }
  }),
)

function useTheme(theme: ThemePref) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121316' : '#f4f5f7')
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Con un diálogo de confirmación abierto los atajos no hacen nada.
      if (isConfirmOpen()) return
      // Esc sale de pantalla completa (los popovers y diálogos lo consumen antes si están abiertos).
      if (e.key === 'Escape' && !e.defaultPrevented && useApp.getState().fullscreen) {
        e.preventDefault()
        setFullscreen(false)
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const { view, lastFolderId } = useApp.getState()
        if (view.kind === 'note') closeNote()
        else if (view.kind === 'trash') openFolder(lastFolderId)
        requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT)))
      }
    }
    // Soltar un fichero fuera del editor no debe hacer que el navegador navegue hasta él.
    const onFileDrag = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragover', onFileDrag)
    window.addEventListener('drop', onFileDrag)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', onFileDrag)
      window.removeEventListener('drop', onFileDrag)
    }
  }, [])
}

function MainView() {
  const view = useApp((s) => s.view)
  const dataReady = useApp((s) => s.dataReady)
  const noteOpen = useApp((s) => {
    if (s.view.kind !== 'note') return true
    const note = s.notes[s.view.noteId]
    return Boolean(note && !note.trashed)
  })

  // Si la nota abierta desaparece o va a la papelera en otro dispositivo, se vuelve a la lista
  // (lo pendiente se guarda en ella y se puede recuperar desde la papelera).
  useEffect(() => {
    if (dataReady && !noteOpen) closeNote()
  }, [dataReady, noteOpen])

  if (!dataReady) return <LoadingScreen />
  if (view.kind === 'note' && noteOpen) {
    return (
      <ErrorBoundary key={view.noteId} message={t("The note couldn't be opened.", 'No se ha podido abrir la nota.')}>
        <Suspense fallback={<LoadingScreen />}>
          <NoteEditor key={view.noteId} noteId={view.noteId} />
        </Suspense>
      </ErrorBoundary>
    )
  }
  if (view.kind === 'trash') return <TrashScreen />
  return <NotesScreen folderId={view.kind === 'notes' ? view.folderId : null} />
}

export function App() {
  return (
    <>
      <Screens />
      <UpdateBanner />
    </>
  )
}

function Screens() {
  const authReady = useApp((s) => s.authReady)
  const user = useApp((s) => s.user)
  const theme = useApp((s) => s.theme)
  const fullscreen = useApp((s) => s.fullscreen)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed)
  const sidebarWidth = useApp((s) => s.sidebarWidth)
  useTheme(theme)
  useGlobalShortcuts()

  if (backendError) return <SetupScreen />
  if (!authReady) return <LoadingScreen />
  if (!user) return <LoginScreen />

  return (
    <div
      className="app"
      data-fullscreen={fullscreen}
      data-sidebar-open={sidebarOpen}
      data-sidebar-collapsed={sidebarCollapsed}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <Sidebar />
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden />
      <main className="main">
        <MainView />
      </main>
      <ConfirmHost />
    </div>
  )
}
