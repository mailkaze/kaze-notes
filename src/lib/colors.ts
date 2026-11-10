import { t } from './i18n'
import type { NoteColorId } from './types'

/** Paleta de fondos de nota. Los valores reales viven en global.css (`--note-<id>`), con variante clara y oscura. */
export const NOTE_COLORS: { id: NoteColorId; label: string }[] = [
  { id: 'coral', label: t('Coral', 'Coral') },
  { id: 'tangerine', label: t('Tangerine', 'Mandarina') },
  { id: 'sunshine', label: t('Sunshine', 'Sol') },
  { id: 'lime', label: t('Lime', 'Lima') },
  { id: 'mint', label: t('Mint', 'Menta') },
  { id: 'aqua', label: t('Aqua', 'Turquesa') },
  { id: 'sky', label: t('Sky', 'Cielo') },
  { id: 'periwinkle', label: t('Periwinkle', 'Lavanda') },
  { id: 'grape', label: t('Grape', 'Uva') },
  { id: 'bubblegum', label: t('Bubblegum', 'Chicle') },
]

/** Valor CSS del fondo de una nota (blanco/superficie por defecto). */
export function noteBg(color: NoteColorId | null): string {
  return color ? `var(--note-${color})` : 'var(--note-default)'
}
