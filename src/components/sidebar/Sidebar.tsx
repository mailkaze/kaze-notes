import { FolderPlus, Inbox, LogOut, PanelLeftClose, SquarePen, Trash } from 'lucide-react'
import { useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { t } from '../../lib/i18n'
import type { AppUser } from '../../lib/types'
import { createFolder, createNote, openFolder, openTrash, setSidebarWidth, signOut, useApp } from '../../state/store'
import { hideSidebar, ThemeToggle } from '../ui/controls'
import { SidebarTree } from './SidebarTree'
import './sidebar.css'

/** Carpeta "actual" para crear notas: la abierta, la de la nota abierta o la última visitada. */
function Avatar({ user }: { user: AppUser }) {
  const [failed, setFailed] = useState(false)
  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase()
  if (user.photoURL && !failed) {
    return (
      <img className="sb-avatar" src={user.photoURL} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    )
  }
  return (
    <span className="sb-avatar" aria-hidden>
      {initial}
    </span>
  )
}

/** Asa para cambiar el ancho de la barra (solo en pantallas anchas; el CSS la oculta en el cajón). */
function Resizer() {
  const width = useApp((s) => s.sidebarWidth)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const left = handle.parentElement?.getBoundingClientRect().left ?? 0
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('sb-resizing')
    const move = (ev: PointerEvent) => setSidebarWidth(ev.clientX - left)
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      document.body.classList.remove('sb-resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setSidebarWidth(width - 16)
    else if (e.key === 'ArrowRight') setSidebarWidth(width + 16)
    else return
    e.preventDefault()
  }

  return (
    <div
      className="sb-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize sidebar', 'Cambiar el ancho de la barra lateral')}
      aria-valuenow={width}
      aria-valuemin={220}
      aria-valuemax={480}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}

export function Sidebar() {
  const view = useApp((s) => s.view)
  const user = useApp((s) => s.user)
  const activeCount = useApp((s) => Object.values(s.notes).filter((n) => !n.trashed).length)
  const trashCount = useApp((s) => Object.values(s.notes).filter((n) => n.trashed).length)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const newFolder = () => {
    const id = createFolder(null, t('New folder', 'Nueva carpeta'))
    if (id) setRenamingId(id)
  }

  const allActive = view.kind === 'notes' && view.folderId === null
  const trashActive = view.kind === 'trash'

  return (
    <aside className="sidebar" aria-label={t('Sidebar', 'Barra lateral')}>
      <div className="sb-header">
        <span className="sb-brand">
          <img src="/favicon.svg" width={30} height={30} alt="Kaze Notes" title="Kaze Notes" />
        </span>
        <button
          type="button"
          className="icon-btn"
          title={t('New note (outside folders)', 'Nueva nota (fuera de carpetas)')}
          aria-label={t('New note', 'Nueva nota')}
          onClick={() => createNote(null)}
        >
          <SquarePen size={18} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t('New folder', 'Nueva carpeta')}
          aria-label={t('New folder', 'Nueva carpeta')}
          onClick={newFolder}
        >
          <FolderPlus size={18} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t('Hide sidebar', 'Ocultar barra lateral')}
          aria-label={t('Hide sidebar', 'Ocultar barra lateral')}
          onClick={hideSidebar}
        >
          <PanelLeftClose size={18} />
        </button>
      </div>

      <div className="sb-scroll">
        <nav className="sb-nav" aria-label={t('Views', 'Vistas')}>
          <button
            type="button"
            className="sb-nav-item"
            data-active={allActive}
            aria-current={allActive ? 'page' : undefined}
            onClick={() => openFolder(null)}
          >
            <Inbox size={17} aria-hidden />
            <span className="sb-nav-label">{t('All notes', 'Todas las notas')}</span>
            {activeCount > 0 && <span className="tree-count">{activeCount}</span>}
          </button>
          <button
            type="button"
            className="sb-nav-item"
            data-active={trashActive}
            aria-current={trashActive ? 'page' : undefined}
            onClick={openTrash}
          >
            <Trash size={17} aria-hidden />
            <span className="sb-nav-label">{t('Trash', 'Papelera')}</span>
            {trashCount > 0 && <span className="tree-count">{trashCount}</span>}
          </button>
        </nav>
        <SidebarTree renamingId={renamingId} setRenamingId={setRenamingId} />
      </div>

      {user && (
        <div className="sb-footer">
          <Avatar user={user} />
          <div className="sb-user">
            <span className="sb-user-name">{user.name || user.email}</span>
            {user.name && user.email && <span className="sb-user-email">{user.email}</span>}
          </div>
          <ThemeToggle />
          <button
            type="button"
            className="icon-btn"
            title={t('Sign out', 'Cerrar sesión')}
            aria-label={t('Sign out', 'Cerrar sesión')}
            onClick={() => void signOut()}
          >
            <LogOut size={18} />
          </button>
        </div>
      )}
      <Resizer />
    </aside>
  )
}
