import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { findSuggestionMatch, type SuggestionProps } from '@tiptap/suggestion'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { loadEmojiIndex, searchEmoji, type EmojiEntry } from './emoji'

interface MenuState {
  items: EmojiEntry[]
  selected: number
  rect: DOMRect | null
  pick: (item: EmojiEntry) => void
}

/** Estado del menú de emojis, compartido entre el plugin de sugerencias y el componente React. */
export class EmojiMenuController {
  private state: MenuState | null = null
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = () => this.state

  set(state: MenuState | null) {
    this.state = state
    this.listeners.forEach((fn) => fn())
  }

  show(props: SuggestionProps<EmojiEntry, EmojiEntry>) {
    // Mientras se buscan los resultados se mantienen los anteriores (evita parpadeos al escribir).
    const items = props.loading ? (this.state?.items ?? []) : props.items
    this.set({ items, selected: 0, rect: props.clientRect?.() ?? null, pick: props.command })
  }

  hide() {
    if (this.state) this.set(null)
  }

  /** Teclado mientras el menú está abierto: ↑/↓ navegan, Intro/Tab insertan. */
  onKeyDown(event: KeyboardEvent): boolean {
    const state = this.state
    if (!state || state.items.length === 0) return false
    const count = state.items.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1
      this.set({ ...state, selected: (state.selected + step + count) % count })
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      state.pick(state.items[state.selected])
      return true
    }
    return false
  }
}

export const emojiSuggestionKey = new PluginKey('emojiSuggestion')

// Consulta válida tras ":" (excluye p. ej. "10:30" o ":)").
const QUERY = /^[\p{L}\p{N}_+-]+$/u

/** Autocompletado de emojis al estilo de macOS/Slack: ":nombre". */
export const EmojiSuggestion = Extension.create<{ controller: EmojiMenuController | null }>({
  name: 'emojiSuggestion',

  addOptions() {
    return { controller: null }
  },

  addProseMirrorPlugins() {
    const controller = this.options.controller
    if (!controller) return []
    return [
      Suggestion<EmojiEntry, EmojiEntry>({
        editor: this.editor,
        pluginKey: emojiSuggestionKey,
        char: ':',
        allowedPrefixes: [' ', ' '],
        decorationClass: 'emoji-query',
        findSuggestionMatch: (config) => {
          const match = findSuggestionMatch(config)
          return match && QUERY.test(match.query) ? match : null
        },
        items: async ({ query }) => searchEmoji(await loadEmojiIndex(), query),
        // El emoji se inserta como texto Unicode normal (se copia tal cual a WhatsApp).
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.insertText(props.emoji, range.from, range.to)
              return true
            })
            .run()
        },
        render: () => ({
          onStart: (props) => controller.show(props),
          onUpdate: (props) => controller.show(props),
          onExit: () => controller.hide(),
          onKeyDown: ({ event }) => controller.onKeyDown(event),
        }),
      }),
    ]
  },
})

const GAP = 6
const MARGIN = 8

export function EmojiMenu({ controller }: { controller: EmojiMenuController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!state?.rect || !el) return
    const { rect } = state
    const w = el.offsetWidth
    const h = el.offsetHeight
    let top = rect.bottom + GAP
    if (top + h > window.innerHeight - MARGIN && rect.top - h - GAP >= MARGIN) top = rect.top - h - GAP
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - w - MARGIN))
    setPos({ top, left })
  }, [state])

  useLayoutEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state?.selected])

  if (!state || state.items.length === 0) return null
  return createPortal(
    <div
      ref={ref}
      className="popover emoji-menu"
      role="listbox"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      // Mantiene el foco (y el teclado del móvil) en el editor.
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) => (
        <button
          key={item.emoji}
          type="button"
          role="option"
          aria-selected={i === state.selected}
          className="menu-item emoji-option"
          onMouseEnter={() => controller.set({ ...state, selected: i })}
          onClick={() => state.pick(item)}
        >
          <span className="emoji-glyph">{item.emoji}</span>
          <span className="emoji-name">{item.name}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
