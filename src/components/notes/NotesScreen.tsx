import { DndContext, DragOverlay, type DragEndEvent } from '@dnd-kit/core'
import { rectSortingStrategy, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Folder as FolderIcon, FolderOpen, LayoutGrid, List, Search, SquarePen, StickyNote, X } from 'lucide-react'
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../lib/i18n'
import { searchNotes } from '../../lib/search'
import { activeNotes, childFolders, folderPath, folderPathLabel, notesInFolder } from '../../lib/tree'
import type { Folder, LayoutMode, Note } from '../../lib/types'
import { createNote, moveNote, openFolder, setLayout, setNoteOrder, setSearch, useApp } from '../../state/store'
import { FOCUS_SEARCH_EVENT, SidebarToggle } from '../ui/controls'
import { SyncIndicator } from '../ui/SyncIndicator'
import { dragEnded, dragStarted, useDragSensors } from '../sidebar/dnd'
import { useSidebarDrop } from '../sidebar/externalDrop'
import { DragPreview } from '../sidebar/TreeRows'
import { NoteCard, SortableNoteCard } from './NoteCard'
import { reorderKey, splitPinned } from './noteSections'
import { useNarrow } from './useNarrow'
import './notes.css'

/** Título con la ruta de la carpeta; cada carpeta antecesora es un enlace. */
function LocationTitle({ folderId }: { folderId: string | null }) {
  const folders = useApp((s) => s.folders)
  const path = folderPath(folders, folderId)
  if (path.length === 0) {
    return (
      <h1 className="screen-title notes-title">
        <span className="notes-crumb-current">{t('All notes', 'Todas las notas')}</span>
      </h1>
    )
  }
  return (
    <h1 className="screen-title notes-title">
      {path.map((folder, i) =>
        i < path.length - 1 ? (
          <Fragment key={folder.id}>
            <button type="button" className="notes-crumb" title={folder.name} onClick={() => openFolder(folder.id)}>
              <span>{folder.name}</span>
            </button>
            <span className="notes-crumb-sep" aria-hidden>
              /
            </span>
          </Fragment>
        ) : (
          <span key={folder.id} className="notes-crumb-current" title={folder.name} aria-current="page">
            {folder.name}
          </span>
        ),
      )}
    </h1>
  )
}

// Se busca al dejar de teclear: con muchas notas, en un móvil cada búsqueda puede tardar.
const SEARCH_DELAY = 180
// Separación entre el puntero y la pastilla de la nota arrastrada sobre la barra lateral.
const CHIP_OFFSET_PX = 12

/**
 * Término de búsqueda ya asentado (vacío al instante al borrarlo). Se lee fuera de React para que
 * la pantalla de notas no se vuelva a pintar con cada tecla, solo el campo de búsqueda.
 */
function useSettledSearch(): string {
  const [settled, setSettled] = useState(() => useApp.getState().search.trim())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useApp.subscribe((s, prev) => {
      if (s.search === prev.search) return
      clearTimeout(timer)
      const query = s.search.trim()
      timer = setTimeout(() => setSettled(query), query ? SEARCH_DELAY : 0)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [])
  return useDeferredValue(settled)
}

function SearchField() {
  const search = useApp((s) => s.search)
  const inputRef = useRef<HTMLInputElement>(null)

  // Cmd/Ctrl+K
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener(FOCUS_SEARCH_EVENT, focus)
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus)
  }, [])

  return (
    <div className="notes-search" role="search">
      <Search size={16} className="notes-search-icon" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={search}
        placeholder={t('Search', 'Buscar')}
        aria-label={t('Search notes', 'Buscar notas')}
        data-testid="search-input"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          if (search) setSearch('')
          else e.currentTarget.blur()
        }}
      />
      {search && (
        <button
          type="button"
          className="icon-btn notes-search-clear"
          aria-label={t('Clear search', 'Borrar búsqueda')}
          title={t('Clear search', 'Borrar búsqueda')}
          onClick={() => {
            setSearch('')
            inputRef.current?.focus()
          }}
        >
          <X size={15} />
        </button>
      )}
    </div>
  )
}

/** Sección ordenable con arrastrar y soltar. El orden es global, así que la barra lateral lo refleja. */
function SortableSection({
  title,
  notes,
  layout,
  showPaths,
}: {
  title?: string
  notes: Note[]
  layout: LayoutMode
  showPaths: boolean
}) {
  const sensors = useDragSensors()
  const folders = useApp((s) => s.folders)
  const [activeId, setActiveId] = useState<string | null>(null)
  const ids = useMemo(() => notes.map((n) => n.id), [notes])
  const active = activeId ? notes.find((n) => n.id === activeId) : undefined
  const pathOf = (note: Note) => (showPaths ? folderPathLabel(folders, note.folderId) : undefined)

  // Soltar sobre una carpeta de la barra lateral (o "Notas") mueve la nota en vez de reordenar.
  const sidebarDrop = useSidebarDrop()

  const finish = () => {
    dragEnded()
    setActiveId(null)
    return sidebarDrop.end()
  }

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    const folderId = finish()
    if (folderId !== undefined) {
      moveNote(String(dragged.id), folderId)
      return
    }
    if (!over) return
    const key = reorderKey(notes, String(dragged.id), String(over.id))
    if (key) setNoteOrder(String(dragged.id), key)
  }

  return (
    <section className="notes-section" aria-label={title}>
      {title && <h2 className="notes-section-title">{title}</h2>}
      <DndContext
        sensors={sensors}
        collisionDetection={sidebarDrop.collisionDetection}
        onDragStart={({ active: dragged }) => {
          dragStarted()
          sidebarDrop.start()
          setActiveId(String(dragged.id))
        }}
        onDragMove={sidebarDrop.move}
        onDragEnd={onDragEnd}
        onDragCancel={finish}
      >
        <SortableContext items={ids} strategy={layout === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}>
          <div className={layout === 'grid' ? 'notes-grid' : 'notes-list'}>
            {notes.map((note) => (
              <SortableNoteCard key={note.id} note={note} layout={layout} path={pathOf(note)} />
            ))}
          </div>
        </SortableContext>
        {createPortal(
          <DragOverlay dropAnimation={sidebarDrop.dropAnimation}>
            {active &&
              (sidebarDrop.compactAt ? (
                // Sobre la barra lateral, una pastilla junto al puntero deja ver la carpeta de destino.
                <div
                  className="notes-drag-chip"
                  style={{ left: sidebarDrop.compactAt.x + CHIP_OFFSET_PX, top: sidebarDrop.compactAt.y + CHIP_OFFSET_PX }}
                >
                  <DragPreview item={{ kind: 'note', id: active.id }} />
                </div>
              ) : (
                <NoteCard note={active} layout={layout} path={pathOf(active)} overlay />
              ))}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </section>
  )
}

function EmptyState({ icon, text, action }: { icon: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon}
      <p>{text}</p>
      {action}
    </div>
  )
}

function FolderChips({ folders }: { folders: Folder[] }) {
  return (
    <nav className="folder-chips" aria-label={t('Subfolders', 'Subcarpetas')}>
      {folders.map((folder) => (
        <button key={folder.id} type="button" className="folder-chip" title={folder.name} onClick={() => openFolder(folder.id)}>
          <FolderIcon size={15} aria-hidden />
          <span>{folder.name}</span>
        </button>
      ))}
    </nav>
  )
}

export function NotesScreen({ folderId }: { folderId: string | null }) {
  const notes = useApp((s) => s.notes)
  const folders = useApp((s) => s.folders)
  const layout = useApp((s) => s.layout)
  const dataReady = useApp((s) => s.dataReady)
  const narrow = useNarrow()
  const folderMissing = Boolean(folderId && !folders[folderId])

  // Si la carpeta desaparece (borrada en otro dispositivo), se vuelve a "Todas las notas".
  useEffect(() => {
    if (dataReady && folderMissing) openFolder(null)
  }, [dataReady, folderMissing])

  const query = useSettledSearch()
  const results = useMemo(() => (query ? searchNotes(activeNotes(notes), query) : null), [notes, query])
  const list = useMemo(() => (folderId ? notesInFolder(notes, folderId) : activeNotes(notes)), [notes, folderId])
  const { pinned, others } = useMemo(() => splitPinned(list), [list])
  const subfolders = useMemo(() => (folderId ? childFolders(folders, folderId) : []), [folders, folderId])
  const showPaths = folderId === null

  const newNoteButton = (
    <button type="button" className="btn btn-primary" onClick={() => createNote(folderId)}>
      <SquarePen size={16} />
      {t('New note', 'Nueva nota')}
    </button>
  )

  let body: ReactNode
  if (results) {
    body =
      results.length > 0 ? (
        <section className="notes-section" aria-label={t('Search results', 'Resultados de la búsqueda')}>
          <h2 className="notes-section-title">
            {results.length === 1
              ? t('1 result', '1 resultado')
              : t(`${results.length} results`, `${results.length} resultados`)}
          </h2>
          <div className={layout === 'grid' ? 'notes-grid' : 'notes-list'}>
            {results.map((note) => (
              <NoteCard key={note.id} note={note} layout={layout} path={folderPathLabel(folders, note.folderId)} />
            ))}
          </div>
        </section>
      ) : (
        <EmptyState
          icon={<Search size={34} strokeWidth={1.5} aria-hidden />}
          text={t('No notes match your search', 'Ninguna nota coincide con la búsqueda')}
        />
      )
  } else {
    const both = pinned.length > 0 && others.length > 0
    body = (
      <>
        {subfolders.length > 0 && <FolderChips folders={subfolders} />}
        {pinned.length > 0 && (
          <SortableSection title={both ? t('Pinned', 'Fijadas') : undefined} notes={pinned} layout={layout} showPaths={showPaths} />
        )}
        {others.length > 0 && (
          <SortableSection title={both ? t('Others', 'Otras') : undefined} notes={others} layout={layout} showPaths={showPaths} />
        )}
        {list.length === 0 &&
          (folderId ? (
            <EmptyState
              icon={<FolderOpen size={34} strokeWidth={1.5} aria-hidden />}
              text={
                subfolders.length > 0
                  ? t('No notes in this folder', 'No hay notas en esta carpeta')
                  : t('This folder is empty', 'Esta carpeta está vacía')
              }
              action={newNoteButton}
            />
          ) : (
            <EmptyState
              icon={<StickyNote size={34} strokeWidth={1.5} aria-hidden />}
              text={t('No notes yet', 'Todavía no hay notas')}
              action={newNoteButton}
            />
          ))}
      </>
    )
  }

  return (
    <div className="notes-screen">
      <header className="screen-header notes-header">
        <SidebarToggle />
        <LocationTitle folderId={folderId} />
        <SearchField />
        <div className="notes-header-actions">
          <div className="layout-toggle" role="group" aria-label={t('Layout', 'Vista')}>
            <button
              type="button"
              className="icon-btn"
              data-active={layout === 'grid'}
              aria-pressed={layout === 'grid'}
              aria-label={t('Grid', 'Mosaico')}
              title={t('Grid', 'Mosaico')}
              onClick={() => setLayout('grid')}
            >
              <LayoutGrid size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              data-active={layout === 'list'}
              aria-pressed={layout === 'list'}
              aria-label={t('List', 'Lista')}
              title={t('List', 'Lista')}
              onClick={() => setLayout('list')}
            >
              <List size={18} />
            </button>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('New note', 'Nueva nota')}
            title={t('New note', 'Nueva nota')}
            onClick={() => createNote(folderId)}
          >
            <SquarePen size={18} />
          </button>
          <SyncIndicator compact={narrow} />
        </div>
      </header>
      <div className="screen-body notes-body">
        <div className="notes-content" data-layout={layout}>
          {body}
        </div>
      </div>
    </div>
  )
}
