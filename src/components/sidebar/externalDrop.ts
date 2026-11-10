import { closestCenter, type CollisionDetection } from '@dnd-kit/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

/**
 * Puente entre el arrastre de tarjetas de la pantalla de notas y la barra lateral (cada una con su
 * propio DndContext): qué carpeta de la barra lateral está bajo el puntero mientras se arrastra una tarjeta.
 */
interface ExternalDrop {
  dragging: boolean
  /** Destino bajo el puntero ("folder:<id>", "root-top" o "root"), o null. */
  overId: string | null
}

export const useExternalDrop = create<ExternalDrop>(() => ({ dragging: false, overId: null }))

/** Carpeta de destino de un `data-drop-id`: su id, null para la raíz o undefined si no admite tarjetas. */
export function dropFolderId(dropId: string): string | null | undefined {
  if (dropId === 'root' || dropId === 'root-top') return null
  if (dropId.startsWith('folder:')) return dropId.slice('folder:'.length)
  return undefined
}

interface Point {
  x: number
  y: number
}

interface SidebarHit {
  /** El puntero está sobre la barra lateral. */
  inside: boolean
  /** Destino bajo el puntero ("folder:<id>", "root-top" o "root"), o null. */
  target: string | null
  scroller: HTMLElement | null
}

/**
 * Qué hay de la barra lateral bajo el punto. La tarjeta arrastrada está encima del puntero, así que se mira
 * toda la pila de elementos. Destino: el primer elemento con `data-drop-id`, si es una carpeta o la raíz;
 * una nota del árbol cuenta como la carpeta que la contiene (`data-drop-folder`).
 */
function sidebarHit(x: number, y: number): SidebarHit {
  const stack = document.elementsFromPoint(x, y)
  const scroller = stack.map((node) => node.closest<HTMLElement>('.sb-scroll')).find((node) => node !== null) ?? null
  const inside = scroller !== null || stack.some((node) => node.closest('.sidebar') !== null)
  let target: string | null = null
  for (const node of stack) {
    if (!(node instanceof HTMLElement) || node.dataset.dropId === undefined) continue
    const id = node.dataset.dropFolder ?? node.dataset.dropId
    target = dropFolderId(id) !== undefined ? id : null
    break
  }
  return { inside, target, scroller }
}

// Franja junto al borde superior o inferior de la barra lateral que la desplaza al arrastrar una tarjeta.
const EDGE_PX = 48
const MAX_SCROLL_STEP_PX = 14

/** Desplazamiento de la barra lateral para el puntero en `y`: negativo hacia arriba, 0 fuera de los bordes. */
function scrollStep(scroller: HTMLElement, y: number): number {
  const rect = scroller.getBoundingClientRect()
  const fromTop = y - rect.top
  const fromBottom = rect.bottom - y
  const ease = (distance: number) => Math.ceil(MAX_SCROLL_STEP_PX * (1 - Math.max(distance, 0) / EDGE_PX))
  if (fromTop < EDGE_PX) return -ease(fromTop)
  if (fromBottom < EDGE_PX) return ease(fromBottom)
  return 0
}

/**
 * Para el DndContext de la pantalla de notas: sobre la barra lateral no hay reordenación (ninguna colisión),
 * la fila destino se publica para que la barra lateral la resalte y la tarjeta se reduce para no taparla.
 */
export function useSidebarDrop() {
  const hitRef = useRef<SidebarHit | null>(null)
  const pointerRef = useRef<Point | null>(null)
  // Punto de la tarjeta por el que se agarró (relativo a su esquina superior izquierda).
  const grabRef = useRef<Point | null>(null)
  const frameRef = useRef(0)
  // Sobre la barra lateral: dónde va la tarjeta reducida dentro de la capa de arrastre (el punto agarrado).
  const [compactAt, setCompactAt] = useState<Point | null>(null)

  // La detección de colisiones corre durante el render: aquí solo se lee, se publica en `publish`.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const p = args.pointerCoordinates
    pointerRef.current = p
    if (p && !grabRef.current) {
      grabRef.current = { x: p.x - args.collisionRect.left, y: p.y - args.collisionRect.top }
    }
    hitRef.current = p ? sidebarHit(p.x, p.y) : null
    return hitRef.current?.inside ? [] : closestCenter(args)
  }, [])

  const publish = useCallback(() => {
    const hit = hitRef.current
    const at = hit?.inside ? grabRef.current : null
    setCompactAt((prev) => (prev?.x === at?.x && prev?.y === at?.y ? prev : at))
    const overId = hit?.target ?? null
    if (useExternalDrop.getState().overId !== overId) useExternalDrop.setState({ overId })
  }, [])

  // Con el puntero quieto junto a un borde la barra lateral sigue desplazándose; el destino se recalcula
  // porque las filas se mueven bajo el puntero sin que dnd-kit lo sepa.
  const autoScroll = useCallback(() => {
    const p = pointerRef.current
    const scroller = hitRef.current?.scroller
    const step = p && scroller ? scrollStep(scroller, p.y) : 0
    if (p && scroller && step) {
      const before = scroller.scrollTop
      scroller.scrollTop += step
      if (scroller.scrollTop !== before) {
        hitRef.current = sidebarHit(p.x, p.y)
        publish()
      }
    }
    frameRef.current = requestAnimationFrame(autoScroll)
  }, [publish])

  const start = useCallback(() => {
    hitRef.current = null
    pointerRef.current = null
    grabRef.current = null
    setCompactAt(null)
    useExternalDrop.setState({ dragging: true, overId: null })
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(autoScroll)
  }, [autoScroll])

  /** Fin del arrastre: carpeta destino (null = raíz) o undefined si no se soltó en la barra lateral. */
  const end = useCallback((): string | null | undefined => {
    cancelAnimationFrame(frameRef.current)
    const overId = hitRef.current?.target ?? null
    hitRef.current = null
    pointerRef.current = null
    useExternalDrop.setState({ dragging: false, overId: null })
    return overId ? dropFolderId(overId) : undefined
  }, [])

  // Si la pantalla de notas se desmonta en pleno arrastre, el bucle no sigue vivo.
  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  return {
    collisionDetection,
    start,
    move: publish,
    end,
    compactAt,
    // Sin animación de vuelta al soltar sobre la barra lateral: la tarjeta reducida no "rebota" a su sitio.
    dropAnimation: compactAt ? null : undefined,
  }
}
