import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { ExternalLink, Italic, List, Paperclip, SquareCheck, Strikethrough, Underline } from 'lucide-react'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n'
import { BoldIcon } from '../ui/controls'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
const MOD = isMac ? '⌘' : 'Ctrl+'
const SHIFT = isMac ? '⇧' : 'Shift+'

interface ToolButtonProps {
  label: string
  shortcut?: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}

function ToolButton({ label, shortcut, active, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className="icon-btn"
      data-active={active ? 'true' : undefined}
      aria-pressed={active === undefined ? undefined : active}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      // Sin robar el foco: la selección del editor se conserva.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Barra discreta de formatos. Sin selección, el formato se aplica a lo que se escriba después. */
export function FormatToolbar({ editor, onAttach }: { editor: Editor; onAttach: () => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bulletList: e.isActive('bulletList') && !e.isActive('taskList'),
      taskList: e.isActive('taskList'),
      link: e.isActive('link') ? String(e.getAttributes('link').href ?? '') : '',
    }),
  })
  const run = (command: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => command(editor.chain().focus()).run()

  return (
    <div className="note-toolbar" role="toolbar" aria-label={t('Text format', 'Formato de texto')}>
      <ToolButton label={t('Bold', 'Negrita')} shortcut={`${MOD}B`} active={state.bold} onClick={() => run((c) => c.toggleBold())}>
        <BoldIcon size={17} />
      </ToolButton>
      <ToolButton label={t('Italic', 'Cursiva')} shortcut={`${MOD}I`} active={state.italic} onClick={() => run((c) => c.toggleItalic())}>
        <Italic size={17} />
      </ToolButton>
      <ToolButton
        label={t('Underline', 'Subrayado')}
        shortcut={`${MOD}U`}
        active={state.underline}
        onClick={() => run((c) => c.toggleUnderline())}
      >
        <Underline size={17} />
      </ToolButton>
      <ToolButton
        label={t('Strikethrough', 'Tachado')}
        shortcut={`${MOD}${SHIFT}S`}
        active={state.strike}
        onClick={() => run((c) => c.toggleStrike())}
      >
        <Strikethrough size={17} />
      </ToolButton>
      <span className="toolbar-sep" aria-hidden />
      <ToolButton
        label={t('Bulleted list', 'Lista con viñetas')}
        shortcut={`${MOD}${SHIFT}8`}
        active={state.bulletList}
        onClick={() => run((c) => c.toggleBulletList())}
      >
        <List size={18} />
      </ToolButton>
      <ToolButton
        label={t('Checkbox', 'Casilla de verificación')}
        shortcut={`${MOD}${SHIFT}9`}
        active={state.taskList}
        onClick={() => run((c) => c.toggleTaskList())}
      >
        <SquareCheck size={18} />
      </ToolButton>
      <span className="toolbar-sep" aria-hidden />
      <ToolButton label={t('Attach file', 'Adjuntar archivo')} onClick={onAttach}>
        <Paperclip size={17} />
      </ToolButton>
      {state.link && (
        <ToolButton
          label={t('Open link', 'Abrir enlace')}
          onClick={() => window.open(state.link, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink size={17} />
        </ToolButton>
      )}
    </div>
  )
}
