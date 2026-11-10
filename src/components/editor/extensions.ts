import { Extension, markInputRule, type AnyExtension, type InputRuleMatch } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Strike from '@tiptap/extension-strike'
import { Placeholder } from '@tiptap/extensions'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { t } from '../../lib/i18n'
import { docToWhatsApp, hasFormattingHtml, looksLikeWhatsApp, whatsAppToHtml } from '../../lib/whatsapp'
import { Attachment } from './attachment'
import { EmojiSuggestion, type EmojiMenuController } from './EmojiMenu'
import { Ink } from './ink'
import { ReorderableTaskItem } from './taskItem'

/**
 * Regla de WhatsApp para un marcador: el de apertura va al principio o tras un espacio/puntuación,
 * y el contenido no empieza ni acaba con espacio. Sin lookbehind (Safari antiguo no lo admite).
 */
function whatsAppRule(marker: string) {
  const m = marker === '*' ? '\\*' : marker
  const re = new RegExp(`(^|[\\s\\p{P}\\p{S}])(${m}([^\\s${m}](?:[^${m}\\n]*[^\\s${m}])?)${m})$`, 'u')
  return (text: string): InputRuleMatch | null => {
    const match = re.exec(text)
    return match ? { index: match.index + match[1].length, text: match[2], replaceWith: match[3] } : null
  }
}

const BOLD_RULE = whatsAppRule('*')
const ITALIC_RULE = whatsAppRule('_')
const STRIKE_RULE = whatsAppRule('~')

// Sustituyen las reglas de Markdown de TipTap (`*x*` = cursiva, `**x**` = negrita…) por las de WhatsApp.
const WhatsAppBold = Bold.extend({
  addInputRules() {
    return [markInputRule({ find: BOLD_RULE, type: this.type })]
  },
  addPasteRules() {
    return []
  },
})

const WhatsAppItalic = Italic.extend({
  addInputRules() {
    return [markInputRule({ find: ITALIC_RULE, type: this.type })]
  },
  addPasteRules() {
    return []
  },
})

const WhatsAppStrike = Strike.extend({
  addInputRules() {
    return [markInputRule({ find: STRIKE_RULE, type: this.type })]
  },
  addPasteRules() {
    return []
  },
})

/** Texto plano del portapapeles en formato WhatsApp (el HTML se mantiene igual). */
export function sliceToWhatsApp(slice: Slice, view: EditorView): string {
  const { $from, $to } = view.state.selection
  let content = slice.content
  // Dentro de un solo párrafo se copia solo el texto, sin viñeta ni casilla.
  if ($from.sameParent($to) && $from.parent.isTextblock) {
    while (content.childCount === 1 && !content.firstChild!.isInline) content = content.firstChild!.content
  }
  return docToWhatsApp(content.toJSON())
}

function syntheticPasteEvent(): ClipboardEvent {
  return typeof ClipboardEvent === 'function' ? new ClipboardEvent('paste') : (new Event('paste') as ClipboardEvent)
}

/** Copiar en formato WhatsApp y pegar texto de WhatsApp conservando formatos, viñetas y casillas. */
const WhatsAppClipboard = Extension.create({
  name: 'whatsAppClipboard',
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('whatsAppClipboard'),
        props: {
          clipboardTextSerializer: (slice, view) => sliceToWhatsApp(slice, view),
          handlePaste: (view, event) => {
            // El pegado sintético de `pasteHTML` no trae portapapeles: sigue el camino normal.
            const data = event.clipboardData
            if (!data) return false
            const text = data.getData('text/plain')
            if (!text || !looksLikeWhatsApp(text) || hasFormattingHtml(data.getData('text/html'))) return false
            return view.pasteHTML(whatsAppToHtml(text), syntheticPasteEvent())
          },
        },
      }),
    ]
  },
})

export interface EditorExtensionOptions {
  /** Menú de emojis (":nombre"). Sin él no hay autocompletado. */
  emoji?: EmojiMenuController
  /** Asa para reordenar casillas arrastrando (necesita una vista montada). */
  reorderableTasks?: boolean
}

export function createExtensions({ emoji, reorderableTasks = false }: EditorExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      bold: false,
      italic: false,
      strike: false,
      heading: false,
      codeBlock: false,
      code: false,
      blockquote: false,
      orderedList: false,
      horizontalRule: false,
      dropcursor: { color: 'var(--accent)', width: 2 },
      link: {
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        defaultProtocol: 'https',
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
      },
    }),
    WhatsAppBold,
    WhatsAppItalic,
    WhatsAppStrike,
    TaskList,
    (reorderableTasks ? ReorderableTaskItem : TaskItem).configure({
      nested: true,
      a11y: {
        checkboxLabel: (node, checked) =>
          `${checked ? t('Done', 'Hecho') : t('To do', 'Pendiente')}: ${node.textContent || t('empty task', 'tarea vacía')}`,
      },
    }),
    Attachment,
    Ink,
    Placeholder.configure({ placeholder: t('Write something…', 'Escribe algo…') }),
    WhatsAppClipboard,
    ...(emoji ? [EmojiSuggestion.configure({ controller: emoji })] : []),
  ]
}
