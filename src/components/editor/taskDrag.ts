import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** Hueco (0..n) donde caería el elemento según la posición vertical del puntero. */
export function gapIndexAt(mids: number[], y: number): number {
  let gap = 0
  while (gap < mids.length && mids[gap] < y) gap++
  return gap
}

/** Índice final del elemento `from` soltado en el hueco `gap`, o null si no se mueve. */
export function moveTarget(from: number, gap: number): number | null {
  if (gap === from || gap === from + 1) return null
  return gap > from ? gap - 1 : gap
}

const EDGE = 48
const SCROLL_STEP = 14

/**
 * Arrastre con eventos de puntero (ratón y táctil) de una casilla dentro de su lista.
 * Solo se reordena entre hermanas de la misma lista y en una única transacción (se puede deshacer).
 */
export function startTaskDrag(event: PointerEvent, view: EditorView, getPos: () => number | undefined) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  const pos = getPos()
  if (pos === undefined || !view.editable) return
  const $pos = view.state.doc.resolve(pos)
  if ($pos.parent.type.name !== 'taskList' || $pos.parent.childCount < 2) return
  event.preventDefault()
  event.stopPropagation()

  const from = $pos.index()
  // La vista del nodo puede recrearse durante el arrastre: se guarda la posición y el documento de partida.
  const startDoc = view.state.doc
  const items: HTMLElement[] = []
  let offset = $pos.start()
  $pos.parent.forEach((child) => {
    const dom = view.nodeDOM(offset)
    if (dom instanceof HTMLElement) items.push(dom)
    offset += child.nodeSize
  })
  if (items.length !== $pos.parent.childCount) return

  const scroller = view.dom.closest<HTMLElement>('.note-scroll')
  const indicator = document.createElement('div')
  indicator.className = 'task-drop-indicator'
  indicator.hidden = true
  document.body.append(indicator)
  document.body.classList.add('task-dragging')

  let gap = from
  let lastY = event.clientY
  let frame = 0

  const place = () => {
    const rects = items.map((el) => el.getBoundingClientRect())
    gap = gapIndexAt(
      rects.map((r) => (r.top + r.bottom) / 2),
      lastY,
    )
    const ref = rects[Math.min(gap, rects.length - 1)]
    const y = gap < rects.length ? ref.top : ref.bottom
    indicator.style.top = `${Math.round(y - 1)}px`
    indicator.style.left = `${Math.round(ref.left)}px`
    indicator.style.width = `${Math.round(ref.width)}px`
    indicator.hidden = moveTarget(from, gap) === null
  }

  // Desplaza la nota mientras el puntero esté cerca del borde superior o inferior.
  const autoScroll = () => {
    if (scroller) {
      const box = scroller.getBoundingClientRect()
      const step = lastY < box.top + EDGE ? -SCROLL_STEP : lastY > box.bottom - EDGE ? SCROLL_STEP : 0
      if (step) {
        scroller.scrollTop += step
        place()
      }
    }
    frame = requestAnimationFrame(autoScroll)
  }

  const onMove = (e: PointerEvent) => {
    lastY = e.clientY
    place()
  }

  const finish = (drop: boolean) => {
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    indicator.remove()
    document.body.classList.remove('task-dragging')
    if (drop) moveItem(view, pos, startDoc, gap)
  }
  const onUp = () => finish(true)
  const onCancel = () => finish(false)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    finish(false)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
  place()
  frame = requestAnimationFrame(autoScroll)
}

function moveItem(view: EditorView, pos: number, startDoc: ProseMirrorNode, gap: number) {
  const { state } = view
  // Si el documento cambió mientras se arrastraba (p. ej. llegó una edición remota), no se mueve nada.
  if (view.isDestroyed || state.doc !== startDoc) return
  const $pos = state.doc.resolve(pos)
  const list = $pos.parent
  const from = $pos.index()
  const target = Math.min(gap, list.childCount)
  if (moveTarget(from, target) === null) return

  const item = list.child(from)
  let insertAt = $pos.start()
  for (let i = 0; i < target; i++) insertAt += list.child(i).nodeSize
  const tr = state.tr.delete(pos, pos + item.nodeSize)
  const at = tr.mapping.map(insertAt)
  tr.insert(at, item)
  // Si el cursor estaba dentro de la casilla, se mueve con ella.
  const { selection } = state
  if (selection instanceof TextSelection && selection.from >= pos && selection.to <= pos + item.nodeSize) {
    tr.setSelection(TextSelection.create(tr.doc, at + selection.anchor - pos, at + selection.head - pos))
  }
  view.dispatch(tr)
}
