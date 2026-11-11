import { Monitor, Moon, PanelLeft, Sun } from 'lucide-react'
import type { SVGProps } from 'react'
import { t } from '../../lib/i18n'
import type { ThemePref } from '../../lib/types'
import { setSidebarCollapsed, setSidebarOpen, setTheme, useApp } from '../../state/store'

export const NARROW_QUERY = '(max-width: 899px)'

/** Evento global (window) que pide a la pantalla de notas que enfoque el buscador (Cmd/Ctrl+K). */
export const FOCUS_SEARCH_EVENT = 'kaze:focus-search'

export function isNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches
}

/**
 * Botón para mostrar la barra lateral. Visible siempre en pantallas estrechas
 * y en pantallas anchas solo cuando la barra está oculta (lo controla el CSS).
 */
export function SidebarToggle() {
  return (
    <button
      type="button"
      className="icon-btn sidebar-toggle"
      title={t('Show sidebar', 'Mostrar barra lateral')}
      aria-label={t('Show sidebar', 'Mostrar barra lateral')}
      onClick={() => (isNarrow() ? setSidebarOpen(true) : setSidebarCollapsed(false))}
    >
      <PanelLeft size={21} />
    </button>
  )
}

/** Oculta la barra lateral (cajón en pantallas estrechas, columna en anchas). */
export function hideSidebar() {
  if (isNarrow()) setSidebarOpen(false)
  else setSidebarCollapsed(true)
}

const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }

export function ThemeToggle() {
  const theme = useApp((s) => s.theme)
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  const label =
    theme === 'light'
      ? t('Theme: light', 'Tema: claro')
      : theme === 'dark'
        ? t('Theme: dark', 'Tema: oscuro')
        : t('Theme: system', 'Tema: sistema')
  return (
    <button type="button" className="icon-btn" title={label} aria-label={label} onClick={() => setTheme(NEXT_THEME[theme])}>
      <Icon size={21} />
    </button>
  )
}

/** Icono de negrita (lucide-react no lo incluye en esta versión). */
export function BoldIcon({ size = 18, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" />
    </svg>
  )
}
