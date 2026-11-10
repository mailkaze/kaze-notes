import type { Editor } from '@tiptap/core'
import { Selection, TextSelection, type EditorState } from '@tiptap/pm/state'
import { EditorContent, useEditor, type UseEditorOptions } from '@tiptap/react'
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from 'react'
import { hasContent, parseContent, previewFromDoc } from '../../lib/docText'
import { noteBg } from '../../lib/colors'
import { t } from '../../lib/i18n'
import {
  createConflictCopy,
  markClean,
  markDirty,
  registerFlush,
  setFullscreen,
  updateNote,
  useApp,
} from '../../state/store'
import { insertFiles, registerLiveEditor } from './attachment'
import { EmojiMenu, EmojiMenuController, emojiSuggestionKey } from './EmojiMenu'
import { createExtensions } from './extensions'
import { FormatToolbar } from './FormatToolbar'
import { NoteHeader } from './NoteHeader'
import './editor.css'

const SAVE_DELAY = 600
const MAX_WAIT = 3000

function hasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types).includes('Files'))
}

/** Sustituye el documento por la versión llegada de otro dispositivo, sin historial y sin disparar el guardado. */
function applyRemoteContent(editor: Editor, content: string) {
  const { state, view } = editor
  let doc
  try {
    const json = parseContent(content)
    doc = json ? state.schema.nodeFromJSON(json) : state.schema.topNodeType.createAndFill()
  } catch {
    return
  }
  if (!doc || doc.eq(state.doc)) return
  const { anchor, head } = state.selection
  const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content)
  const size = tr.doc.content.size
  tr.setSelection(TextSelection.between(tr.doc.resolve(Math.min(anchor, size)), tr.doc.resolve(Math.min(head, size))))
  view.dispatch(tr.setMeta('addToHistory', false).setMeta('preventUpdate', true))
}

export function NoteEditor({ noteId }: { noteId: string }) {
  const exists = useApp((s) => Boolean(s.notes[noteId]))
  return exists ? <EditorScreen noteId={noteId} /> : null
}

function EditorScreen({ noteId }: { noteId: string }) {
  const note = useApp((s) => s.notes[noteId])
  const [initial] = useState(() => useApp.getState().notes[noteId])
  const [title, setTitle] = useState(initial.title)
  const [emoji] = useState(() => new EmojiMenuController())
  const titleRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // ---------- Guardado con debounce ----------
  const dirtyKey = `note:${noteId}`
  const saved = useRef({ title: initial.title, content: initial.content })
  const pending = useRef({ dirty: false, timer: 0, since: 0, title: initial.title })
  const latest = useRef<EditorState | null>(null)
  // Fuerza a aplicar una versión remota que llegó mientras había cambios locales que al final no se guardaron.
  const [resync, setResync] = useState(0)

  const flush = useCallback(() => {
    const p = pending.current
    window.clearTimeout(p.timer)
    p.timer = 0
    p.since = 0
    if (!p.dirty) return
    p.dirty = false
    const state = latest.current
    if (state) {
      const json = state.doc.toJSON()
      const content = JSON.stringify(json)
      // Versión de otro dispositivo que no se aplicó al editor porque había cambios sin guardar.
      const stored = useApp.getState().notes[noteId]
      const remote =
        stored && (stored.content !== saved.current.content || stored.title !== saved.current.title) ? stored : null
      if (content !== saved.current.content || p.title !== saved.current.title) {
        if (remote) {
          // No se sobrescribe: se guarda como nota aparte y después se escribe la versión local.
          if (remote.content !== content || remote.title !== p.title) createConflictCopy(noteId, remote)
          saved.current = { title: remote.title, content: remote.content }
        }
        if (updateNote(noteId, { title: p.title, content, preview: previewFromDoc(json) })) {
          saved.current = { title: p.title, content }
        }
      } else if (remote) {
        setResync((n) => n + 1)
      }
    }
    markClean(dirtyKey)
  }, [noteId, dirtyKey])

  const schedule = useCallback(() => {
    const p = pending.current
    p.dirty = true
    markDirty(dirtyKey)
    const now = Date.now()
    if (!p.since) p.since = now
    window.clearTimeout(p.timer)
    p.timer = window.setTimeout(flush, Math.max(0, Math.min(SAVE_DELAY, p.since + MAX_WAIT - now)))
  }, [flush, dirtyKey])

  useEffect(() => {
    const unregister = registerFlush(flush)
    return () => {
      unregister()
      flush()
    }
  }, [flush])

  // ---------- Editor ----------
  // Opciones creadas una sola vez: useEditor llama a setOptions (y redibuja todo el documento,
  // destruyendo las vistas de los nodos) cada vez que recibe objetos distintos en un render.
  const [options] = useState<UseEditorOptions>(() => ({
    extensions: createExtensions({ emoji, reorderableTasks: true }),
    content: parseContent(initial.content) ?? '',
    autofocus: !initial.title && !hasContent(parseContent(initial.content)) ? 'start' : false,
    editorProps: {
      attributes: { class: 'note-body', spellcheck: 'true', 'aria-label': t('Note text', 'Texto de la nota') },
      handleDrop: (view, event, _slice, moved) => {
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (moved || files.length === 0) return false
        // Se inserta donde se suelta, no al final.
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        insertFiles(view, noteId, files, at?.pos ?? view.state.doc.content.size)
        return true
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData
        const files = Array.from(data?.files ?? [])
        if (!data || files.length === 0) return false
        // Imagen copiada o ficheros del Finder; si hay texto con HTML (p. ej. una hoja de cálculo) se pega el texto.
        if (data.getData('text/html') && data.getData('text/plain').trim()) return false
        insertFiles(view, noteId, files)
        return true
      },
      handleKeyDown: (view, event) => {
        // ProseMirror anula siempre Esc, así que la salida de pantalla completa se gestiona aquí
        // (salvo que Esc cierre antes el menú de emojis).
        if (event.key === 'Escape') {
          if (emojiSuggestionKey.getState(view.state)?.active || !useApp.getState().fullscreen) return false
          setFullscreen(false)
          return true
        }
        if (event.key !== 'ArrowUp' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
        const { selection, doc } = view.state
        if (!selection.empty || selection.from !== Selection.atStart(doc).from) return false
        titleRef.current?.focus()
        return true
      },
      handleDOMEvents: {
        // Cmd/Ctrl+clic abre el enlace (el clic normal solo coloca el cursor).
        click: (_view, event) => {
          if (!(event.metaKey || event.ctrlKey)) return false
          const link = (event.target as Element | null)?.closest?.('a[href]')
          if (!(link instanceof HTMLAnchorElement)) return false
          event.preventDefault()
          window.open(link.href, '_blank', 'noopener,noreferrer')
          return true
        },
      },
    },
    onCreate: ({ editor: e }) => {
      latest.current = e.state
    },
    onTransaction: ({ editor: e }) => {
      latest.current = e.state
    },
    onUpdate: () => schedule(),
    onBlur: () => emoji.hide(),
  }))
  const editor = useEditor(options)

  // Las subidas que terminan después de cerrar y reabrir la nota actualizan este editor.
  useEffect(() => registerLiveEditor(noteId, editor), [noteId, editor])

  // ---------- Cambios llegados de otro dispositivo ----------
  // Con cambios locales sin guardar no se aplican: `flush` los conserva como nota aparte.
  const remoteContent = note?.content
  const remoteTitle = note?.title
  useEffect(() => {
    if (remoteContent === undefined || pending.current.dirty || remoteContent === saved.current.content) return
    saved.current.content = remoteContent
    applyRemoteContent(editor, remoteContent)
  }, [editor, remoteContent, resync])
  useEffect(() => {
    if (remoteTitle === undefined || pending.current.dirty || remoteTitle === saved.current.title) return
    saved.current.title = remoteTitle
    pending.current.title = remoteTitle
    setTitle(remoteTitle)
  }, [remoteTitle, resync])

  // Soltar ficheros fuera del editor nunca debe hacer que el navegador abra el fichero.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault()
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const onTitleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value)
    pending.current.title = e.target.value
    schedule()
  }

  // Ficheros soltados en la nota pero fuera del texto (cabecera, márgenes): al final.
  const onDrop = (e: ReactDragEvent) => {
    if (e.nativeEvent.defaultPrevented) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    e.preventDefault()
    insertFiles(editor.view, noteId, files, editor.state.doc.content.size)
  }

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length) insertFiles(editor.view, noteId, files)
  }

  if (!note) return null
  return (
    <div
      className="note-editor"
      data-colored={note.color ? 'true' : 'false'}
      style={{ background: noteBg(note.color) }}
      onDragOver={(e) => hasFiles(e.dataTransfer) && e.preventDefault()}
      onDrop={onDrop}
    >
      <NoteHeader note={note} />
      <FormatToolbar editor={editor} onAttach={() => fileRef.current?.click()} />
      <div className="note-scroll">
        <div className="note-page">
          <input
            ref={titleRef}
            className="note-title"
            value={title}
            onChange={onTitleChange}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing) {
                e.preventDefault()
                editor.commands.focus('start')
              }
            }}
            placeholder={t('Title', 'Título')}
            aria-label={t('Title', 'Título')}
            enterKeyHint="next"
            autoComplete="off"
          />
          <EditorContent editor={editor} className="note-content" />
        </div>
      </div>
      <input ref={fileRef} type="file" multiple hidden onChange={onPickFiles} />
      <EmojiMenu controller={emoji} />
    </div>
  )
}
