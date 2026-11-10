import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  children: ReactNode
  placement?: 'bottom-start' | 'bottom-end'
  className?: string
}

const GAP = 6
const MARGIN = 8

/**
 * Capa flotante anclada a un elemento. Se recoloca dentro de la ventana,
 * se cierra al pulsar fuera o con Esc (sin propagar Esc al resto de la app).
 */
export function Popover({ anchor, open, onClose, children, placement = 'bottom-start', className }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const el = ref.current
      if (!el) return
      const a = anchor.getBoundingClientRect()
      const w = el.offsetWidth
      const h = el.offsetHeight
      let left = placement === 'bottom-end' ? a.right - w : a.left
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN))
      let top = a.bottom + GAP
      if (top + h > window.innerHeight - MARGIN && a.top - h - GAP >= MARGIN) top = a.top - h - GAP
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, placement])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, anchor, onClose])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      className={`popover ${className ?? ''}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      role="dialog"
    >
      {children}
    </div>,
    document.body,
  )
}
