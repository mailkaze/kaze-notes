import type { ReactNode } from 'react'
import { t } from '../../lib/i18n'

// Casilla al principio de una línea de la vista previa ("☐ " / "☑ ", ver docToLines).
const TASK_LINE = /^(\s*)([☐☑]) (.*)$/u

/** Vista previa con las casillas dibujadas como en el editor en vez de "☐" / "☑"; las hechas, tachadas. */
export function previewContent(preview: string): ReactNode[] {
  return preview.split('\n').flatMap((line, i) => {
    const before = i > 0 ? ['\n'] : []
    const task = TASK_LINE.exec(line)
    if (!task) return [...before, line]
    const done = task[2] === '☑'
    return [
      ...before,
      task[1],
      <span
        key={`check-${i}`}
        className="preview-check"
        data-checked={done || undefined}
        role="img"
        aria-label={done ? t('Done', 'Hecho') : t('To do', 'Pendiente')}
      />,
      <span key={`text-${i}`} className={done ? 'preview-done' : undefined}>
        {task[3]}
      </span>,
    ]
  })
}
