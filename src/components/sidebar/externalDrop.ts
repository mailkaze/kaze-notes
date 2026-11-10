import { closestCenter, type CollisionDetection } from '@dnd-kit/core'
import { useCallback, useRef, useState } from 'react'
import { create } from 'zustand'

/**
 * Puente entre el arrastre de tarjetas de la pantalla de notas y la barra lateral (cada una con su
 * propio DndContext): qué carpeta de la barra lateral está bajo el puntero mientras se arrastra una tarjeta.
 */
interface ExternalDrop {
  dragging: boolean
  /** `data-drop-id` del destino bajo el puntero ("folder:<id>", "root-top" o "root"), o null. */
  overId: string | null
}

export const useExternalDrop = create<ExternalDrop>(() => ({ dragging: false, overId: null }))

/** Carpeta de destino de un `data-drop-id`: su id, null para la raíz o undefined si no admite tarjetas. */
export function dropFolderId(dropId: string): string | null | undefined {
  if (dropId === 'root' || dropId === 'root-top') return null
  if (dropId.startsWith('folder:')) return dropId.slice('folder:'.length)
  return undefined
}

/** Primer elemento con `data-drop-id` bajo el punto; solo cuenta si es una carpeta o la raíz. */
function sidebarTargetAt(x: number, y: number): string | null {
  for (const node of document.elementsFromPoint(x, y)) {
    const id = node instanceof HTMLElement ? node.dataset.dropId : undefined
    if (id !== undefined) return dropFolderId(id) !== undefined ? id : null
  }
  return null
}

/**
 * Para el DndContext de la pantalla de notas: sobre la barra lateral no hay reordenación (ninguna colisión)
 * y la fila destino se publica para que la barra lateral la resalte.
 */
export function useSidebarDrop() {
  const overRef = useRef<string | null>(null)
  // Sin animación de vuelta al soltar en la barra lateral: la tarjeta no "rebota" a su sitio.
  const [onSidebar, setOnSidebar] = useState(false)

  // La detección de colisiones corre durante el render: aquí solo se lee, se publica en `move`.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const p = args.pointerCoordinates
    overRef.current = p ? sidebarTargetAt(p.x, p.y) : null
    return overRef.current ? [] : closestCenter(args)
  }, [])

  const start = useCallback(() => {
    overRef.current = null
    setOnSidebar(false)
    useExternalDrop.setState({ dragging: true, overId: null })
  }, [])

  const move = useCallback(() => {
    const overId = overRef.current
    setOnSidebar(overId !== null)
    if (useExternalDrop.getState().overId !== overId) useExternalDrop.setState({ overId })
  }, [])

  /** Fin del arrastre: carpeta destino (null = raíz) o undefined si no se soltó en la barra lateral. */
  const end = useCallback((): string | null | undefined => {
    const overId = overRef.current
    overRef.current = null
    useExternalDrop.setState({ dragging: false, overId: null })
    return overId ? dropFolderId(overId) : undefined
  }, [])

  return { collisionDetection, start, move, end, dropAnimation: onSidebar ? null : undefined }
}
