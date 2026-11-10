import {
  ArrowLeft,
  Check,
  ChevronDown,
  Ellipsis,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Inbox,
  Maximize2,
  Minimize2,
  Palette,
  Pin,
  PinOff,
  Trash,
} from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { NOTE_COLORS, noteBg } from '../../lib/colors'
import { t } from '../../lib/i18n'
import { folderPathLabel } from '../../lib/tree'
import type { Note, NoteColorId } from '../../lib/types'
import {
  closeNote,
  createFolder,
  moveNote,
  openFolder,
  setColor,
  setPinned,
  toggleFullscreen,
  trashNote,
  useApp,
} from '../../state/store'
import { SidebarToggle } from '../ui/controls'
import { Popover } from '../ui/Popover'
import { SyncIndicator } from '../ui/SyncIndicator'
import { pickerOptions, type PickerOption } from './folderPicker'

function ColorPicker({ value, onPick }: { value: NoteColorId | null; onPick: (color: NoteColorId | null) => void }) {
  const options: { id: NoteColorId | null; label: string }[] = [{ id: null, label: t('No color', 'Sin color') }, ...NOTE_COLORS]
  return (
    <div className="color-grid" role="group" aria-label={t('Note color', 'Color de la nota')}>
      {options.map(({ id, label }) => (
        <button
          key={id ?? 'none'}
          type="button"
          className={`color-swatch${id ? '' : ' color-swatch-none'}`}
          style={{ background: noteBg(id) }}
          data-active={value === id}
          aria-pressed={value === id}
          aria-label={label}
          title={label}
          onClick={() => onPick(id)}
        >
          {value === id && <Check size={15} strokeWidth={3} aria-hidden />}
        </button>
      ))}
    </div>
  )
}

const optionKey = (o: PickerOption) => (o.kind === 'folder' ? o.id : o.kind)

function OptionLabel({ option, filtering }: { option: PickerOption; filtering: boolean }) {
  if (option.kind === 'root') {
    return (
      <>
        <Inbox size={16} aria-hidden />
        <span className="folder-picker-name">{t('No folder', 'Sin carpeta')}</span>
      </>
    )
  }
  if (option.kind === 'create') {
    return (
      <>
        <FolderPlus size={16} aria-hidden />
        <span className="folder-picker-name">{t(`Create folder "${option.name}"`, `Crear carpeta «${option.name}»`)}</span>
      </>
    )
  }
  // Al filtrar se muestra la ruta completa; sin filtro, el árbol con sangría.
  return (
    <>
      <FolderIcon size={16} aria-hidden />
      <span className="folder-picker-name">{filtering ? option.path : option.name}</span>
    </>
  )
}

function FolderPickerPanel({ note, onClose }: { note: Note; onClose: () => void }) {
  const folders = useApp((s) => s.folders)
  const [query, setQuery] = useState('')
  const options = useMemo(() => pickerOptions(folders, query), [folders, query])
  const current = note.folderId && folders[note.folderId] ? note.folderId : null
  const isCurrent = (o: PickerOption) => (o.kind === 'root' ? current === null : o.kind === 'folder' && o.id === current)
  // Sin texto se resalta la carpeta actual; al escribir, la primera coincidencia.
  const [active, setActive] = useState(() => Math.max(0, options.findIndex(isCurrent)))
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const filtering = query.trim() !== ''

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, options])

  const pick = (option: PickerOption | undefined) => {
    if (!option) return
    onClose()
    if (option.kind === 'create') {
      const id = createFolder(null, option.name)
      if (id) moveNote(note.id, id)
      return
    }
    const folderId = option.kind === 'folder' ? option.id : null
    if (folderId !== note.folderId) moveNote(note.id, folderId)
  }

  const step = (delta: number) => setActive((i) => (options.length ? (i + delta + options.length) % options.length : 0))

  return (
    <div className="folder-picker">
      <input
        className="folder-picker-input"
        value={query}
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={options[active] ? `${listId}-${optionKey(options[active])}` : undefined}
        aria-label={t('Search or create folder', 'Buscar o crear carpeta')}
        placeholder={t('Search or create folder…', 'Buscar o crear carpeta…')}
        maxLength={120}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            step(e.key === 'ArrowDown' ? 1 : -1)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(options[active])
          }
        }}
      />
      <div ref={listRef} id={listId} className="folder-picker-list" role="listbox" aria-label={t('Folders', 'Carpetas')}>
        {options.map((option, i) => (
          <div
            key={optionKey(option)}
            id={`${listId}-${optionKey(option)}`}
            role="option"
            aria-selected={i === active}
            data-current={isCurrent(option) || undefined}
            className="menu-item folder-picker-option"
            style={{ '--depth': option.kind === 'folder' && !filtering ? option.depth : 0 } as CSSProperties}
            onMouseMove={() => setActive(i)}
            // Sin robar el foco al campo de texto.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(option)}
          >
            <OptionLabel option={option} filtering={filtering} />
            {isCurrent(option) && <Check size={15} className="folder-picker-check" aria-label={t('Current', 'Actual')} />}
          </div>
        ))}
        {options.length === 0 && <p className="folder-picker-empty">{t('No folders', 'No hay carpetas')}</p>}
      </div>
      {current && (
        <>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onClose()
              openFolder(current)
            }}
          >
            <FolderOpen size={16} aria-hidden />
            {t('Open folder', 'Abrir carpeta')}
          </button>
        </>
      )}
    </div>
  )
}

/** Botón discreto con la carpeta de la nota; abre un selector para moverla o crear una carpeta nueva. */
export function FolderPicker({ note }: { note: Note }) {
  const path = useApp((s) => folderPathLabel(s.folders, note.folderId))
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const label = path || t('No folder', 'Sin carpeta')
  const title = `${t('Move to folder', 'Mover a carpeta')}: ${label}`
  return (
    <div className="note-path">
      <button
        ref={setAnchor}
        type="button"
        className="note-folder-btn"
        data-empty={path ? undefined : true}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <FolderIcon size={15} aria-hidden />
        <span className="note-folder-label">{label}</span>
        <ChevronDown size={14} className="note-folder-chevron" aria-hidden />
      </button>
      <Popover anchor={anchor} open={open} onClose={close} className="folder-picker-pop">
        <FolderPickerPanel note={note} onClose={close} />
      </Popover>
    </div>
  )
}

export function NoteHeader({ note }: { note: Note }) {
  const fullscreen = useApp((s) => s.fullscreen)
  const [colorButton, setColorButton] = useState<HTMLButtonElement | null>(null)
  const [moreButton, setMoreButton] = useState<HTMLButtonElement | null>(null)
  const [menu, setMenu] = useState<'color' | 'more' | null>(null)
  const close = () => setMenu(null)

  const pinLabel = note.pinned ? t('Unpin', 'Desfijar') : t('Pin to top', 'Fijar arriba')
  const fullscreenLabel = fullscreen
    ? t('Exit full screen (Esc)', 'Salir de pantalla completa (Esc)')
    : t('Full screen', 'Pantalla completa')
  const trashLabel = t('Move to trash', 'Mover a la papelera')
  const colorLabel = t('Note color', 'Color de la nota')
  const pickColor = (color: NoteColorId | null) => {
    setColor(note.id, color)
    close()
  }

  return (
    <header className="screen-header note-header">
      <SidebarToggle />
      <button type="button" className="icon-btn" aria-label={t('Back to notes', 'Volver a las notas')} title={t('Back to notes', 'Volver a las notas')} onClick={closeNote}>
        <ArrowLeft size={18} />
      </button>
      <FolderPicker note={note} />
      <SyncIndicator />
      <button
        ref={setColorButton}
        type="button"
        className="icon-btn note-wide-only"
        aria-label={colorLabel}
        title={colorLabel}
        aria-expanded={menu === 'color'}
        onClick={() => setMenu(menu === 'color' ? null : 'color')}
      >
        <Palette size={18} />
      </button>
      <button
        type="button"
        className="icon-btn note-wide-only"
        data-active={note.pinned}
        aria-pressed={note.pinned}
        aria-label={pinLabel}
        title={pinLabel}
        onClick={() => setPinned(note.id, !note.pinned)}
      >
        {note.pinned ? <PinOff size={18} /> : <Pin size={18} />}
      </button>
      <button
        type="button"
        className="icon-btn"
        data-active={fullscreen}
        aria-pressed={fullscreen}
        aria-label={fullscreenLabel}
        title={fullscreenLabel}
        onClick={toggleFullscreen}
      >
        {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </button>
      <button type="button" className="icon-btn note-wide-only" aria-label={trashLabel} title={trashLabel} onClick={() => trashNote(note.id)}>
        <Trash size={18} />
      </button>
      <button
        ref={setMoreButton}
        type="button"
        className="icon-btn note-more"
        aria-label={t('More actions', 'Más acciones')}
        title={t('More actions', 'Más acciones')}
        aria-expanded={menu === 'more'}
        onClick={() => setMenu(menu === 'more' ? null : 'more')}
      >
        <Ellipsis size={18} />
      </button>

      <Popover anchor={colorButton} open={menu === 'color'} onClose={close} placement="bottom-end">
        <ColorPicker value={note.color} onPick={pickColor} />
      </Popover>
      <Popover anchor={moreButton} open={menu === 'more'} onClose={close} placement="bottom-end">
        <ColorPicker value={note.color} onPick={pickColor} />
        <div className="menu-sep" />
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            setPinned(note.id, !note.pinned)
            close()
          }}
        >
          {note.pinned ? <PinOff size={16} /> : <Pin size={16} />}
          {pinLabel}
        </button>
        <button type="button" className="menu-item danger" onClick={() => trashNote(note.id)}>
          <Trash size={16} />
          {trashLabel}
        </button>
      </Popover>
    </header>
  )
}
