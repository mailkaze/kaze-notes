import { mergeAttributes, Node } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView, NodeView } from '@tiptap/pm/view'

/** Ancho lógico de un bloque: los trazos se guardan en estas unidades y se escalan al ancho real. */
export const INK_WIDTH = 2000
export const INK_DEFAULT_HEIGHT = 600
const GROW_MARGIN = 200
const GROW_STEP = 600
const LINE_WIDTH = 7
/** Espacio mínimo sobre el primer trazo de un bloque nuevo. */
const TOP_PAD = 40
/** Píxeles que hay que mover el lápiz para crear un bloque: un toque no escribe. */
const START_DISTANCE = 4
/** Lo que el lápiz pulsa en vez de escribir encima (casillas, enlaces, adjuntos…). */
const CONTROLS = 'a, button, input, label, select, textarea, [contenteditable="false"]'

/** Trazo: tríos [x, y, presión 0-100] seguidos, en unidades lógicas. */
type Stroke = number[]
type ClientPoint = [x: number, y: number, pressure: number]

export interface BlockBox {
  top: number
  bottom: number
  emptyParagraph: boolean
}

/** Dónde va un bloque nuevo: antes del bloque `index` (al final si no existe), o en su lugar. */
export interface InkTarget {
  index: number
  replace: boolean
}

/** Elige el sitio del bloque nuevo según la altura `y` del lápiz y las cajas de los bloques de la nota. */
export function inkTarget(blocks: BlockBox[], y: number): InkTarget {
  const i = blocks.findIndex((b) => b.bottom > y)
  if (i === -1) {
    const last = blocks.length - 1
    return last >= 0 && blocks[last].emptyParagraph ? { index: last, replace: true } : { index: blocks.length, replace: false }
  }
  if (blocks[i].emptyParagraph) return { index: i, replace: true }
  return { index: y < (blocks[i].top + blocks[i].bottom) / 2 ? i : i + 1, replace: false }
}

/** El bloque se alarga cuando se escribe cerca de su borde inferior. */
export function inkHeightFor(height: number, maxY: number): number {
  return maxY > height - GROW_MARGIN ? Math.ceil(maxY + GROW_STEP) : height
}

function parseStrokes(value: string | null): Stroke[] {
  try {
    const strokes: unknown = JSON.parse(value ?? '[]')
    return Array.isArray(strokes)
      ? strokes.filter((s): s is Stroke => Array.isArray(s) && s.every((n) => typeof n === 'number'))
      : []
  } catch {
    return []
  }
}

function pressureOf(e: PointerEvent): number {
  return e.pressure > 0 ? e.pressure : 0.5
}

/** Dibuja el trazo desde el punto `from`; `scale` pasa de unidades lógicas a píxeles del lienzo. */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, scale: number, from = 0) {
  const points = s.length / 3
  if (points === 1 && from === 0) {
    ctx.beginPath()
    ctx.arc(s[0] * scale, s[1] * scale, (LINE_WIDTH * scale) / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  for (let i = Math.max(from, 1); i < points; i++) {
    ctx.lineWidth = LINE_WIDTH * (0.35 + 0.0065 * s[i * 3 + 2]) * scale
    ctx.beginPath()
    ctx.moveTo(s[i * 3 - 3] * scale, s[i * 3 - 2] * scale)
    ctx.lineTo(s[i * 3] * scale, s[i * 3 + 1] * scale)
    ctx.stroke()
  }
}

interface Drawing {
  pointerId: number
  points: Stroke
  fresh: boolean
  offsetY: number
}

const views = new WeakMap<object, InkView>()

class InkView implements NodeView {
  dom: HTMLElement
  private canvas: HTMLCanvasElement
  private node: PMNode
  private height: number
  private drawing: Drawing | null = null
  private resize: ResizeObserver | null = null
  private stopTracking = () => {}

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.node = node
    this.height = node.attrs.height
    this.dom = document.createElement('div')
    this.dom.className = 'ink-block'
    this.dom.contentEditable = 'false'
    this.canvas = document.createElement('canvas')
    this.dom.append(this.canvas)
    this.dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'pen') return
      e.preventDefault()
      this.track(e.pointerId, [[e.clientX, e.clientY, pressureOf(e)]], false)
    })
    views.set(this.dom, this)
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.layout())
      this.resize.observe(this.dom)
    }
    this.layout()
  }

  /** Ajusta el lienzo al ancho real (la altura sale de la proporción) y lo redibuja. */
  private layout() {
    this.canvas.style.aspectRatio = `${INK_WIDTH} / ${this.height}`
    const dpr = window.devicePixelRatio || 1
    const width = this.dom.clientWidth
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(((width * this.height) / INK_WIDTH) * dpr)
    this.redraw()
  }

  private context(): CanvasRenderingContext2D | null {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return null
    ctx.strokeStyle = ctx.fillStyle = getComputedStyle(this.dom).color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    return ctx
  }

  private redraw() {
    const ctx = this.context()
    if (!ctx) return
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const scale = this.canvas.width / INK_WIDTH
    for (const s of this.node.attrs.strokes as Stroke[]) drawStroke(ctx, s, scale)
    if (this.drawing) drawStroke(ctx, this.drawing.points, scale)
  }

  /** Sigue el lápiz `pointerId` desde los puntos ya recibidos hasta que se levanta. */
  track(pointerId: number, start: ClientPoint[], fresh: boolean) {
    this.stopTracking()
    this.layout()
    const rect = this.canvas.getBoundingClientRect()
    if (!rect.width) return
    const unit = rect.width / INK_WIDTH
    // Un bloque nuevo empieza bajo el texto anterior: si el trazo empezó más arriba, se baja para que quepa.
    const offsetY = fresh ? Math.max(0, TOP_PAD - Math.min(...start.map(([, y]) => (y - rect.top) / unit))) : 0
    const drawing: Drawing = { pointerId, points: [], fresh, offsetY }
    this.drawing = drawing

    const add = ([x, y, p]: ClientPoint) => {
      const r = this.canvas.getBoundingClientRect()
      const u = r.width / INK_WIDTH
      const px = Math.round(Math.min(INK_WIDTH, Math.max(0, (x - r.left) / u)))
      const py = Math.round(Math.max(0, (y - r.top) / u + drawing.offsetY))
      const pts = drawing.points
      const n = pts.length
      if (n && pts[n - 3] === px && pts[n - 2] === py) return
      pts.push(px, py, Math.round(p * 100))
      const height = inkHeightFor(this.height, py)
      if (height !== this.height) {
        this.height = height
        this.layout()
      } else {
        const ctx = this.context()
        if (ctx) drawStroke(ctx, pts, this.canvas.width / INK_WIDTH, n / 3)
      }
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      const coalesced = e.getCoalescedEvents?.() ?? []
      for (const ev of coalesced.length ? coalesced : [e]) add([ev.clientX, ev.clientY, pressureOf(ev)])
    }
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      this.stopTracking()
      this.commit(drawing)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    this.stopTracking = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      this.stopTracking = () => {}
    }
    start.forEach(add)
  }

  private commit(drawing: Drawing) {
    this.drawing = null
    const pos = this.getPos()
    if (pos === undefined || drawing.points.length === 0) {
      this.redraw()
      return
    }
    const strokes = [...(this.node.attrs.strokes as Stroke[]), drawing.points]
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, strokes, height: this.height })
    // El primer trazo de un bloque nuevo se deshace junto con su creación; los demás, de uno en uno.
    if (drawing.fresh) tr.setMeta('appendedTransaction', tr)
    else closeHistory(tr)
    this.view.dispatch(tr)
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    if (!this.drawing) this.height = node.attrs.height
    this.layout()
    return true
  }

  stopEvent(e: Event) {
    return e instanceof PointerEvent && e.pointerType === 'pen'
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    this.stopTracking()
    this.resize?.disconnect()
    views.delete(this.dom)
  }
}

/** Crea un bloque vacío donde cae el lápiz (a la altura `y`) y devuelve su vista. */
function insertInk(view: EditorView, y: number): InkView | undefined {
  const { state } = view
  const spots: { pos: number; size: number }[] = []
  const blocks: BlockBox[] = []
  state.doc.forEach((node, pos) => {
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return
    const r = dom.getBoundingClientRect()
    spots.push({ pos, size: node.nodeSize })
    blocks.push({ top: r.top, bottom: r.bottom, emptyParagraph: node.type.name === 'paragraph' && node.content.size === 0 })
  })
  const target = inkTarget(blocks, y)
  const spot = spots[target.index]
  const at = spot ? spot.pos : state.doc.content.size
  const ink = state.schema.nodes.ink.create({ strokes: [], height: INK_DEFAULT_HEIGHT })
  const tr = target.replace && spot ? state.tr.replaceWith(at, at + spot.size, ink) : state.tr.insert(at, ink)
  // Escribir justo después de teclear no debe deshacerse junto con el texto.
  view.dispatch(closeHistory(tr))
  const dom = view.nodeDOM(at)
  return dom ? views.get(dom) : undefined
}

/** Lápiz apoyado fuera de un bloque: cuando se mueve, crea el bloque ahí y le pasa el trazo. */
function startInk(view: EditorView, down: PointerEvent) {
  const points: ClientPoint[] = [[down.clientX, down.clientY, pressureOf(down)]]
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
  }
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return
    points.push([e.clientX, e.clientY, pressureOf(e)])
    if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < START_DISTANCE) return
    stop()
    insertInk(view, down.clientY)?.track(down.pointerId, points, true)
  }
  const end = (e: PointerEvent) => {
    if (e.pointerId === down.pointerId) stop()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}

function penWrites(target: EventTarget | null): boolean {
  return target instanceof Element && (Boolean(target.closest('.ink-block')) || !target.closest(CONTROLS))
}

const penModeKey = new PluginKey<boolean>('inkPen')

/** El Apple Pencil escribe a mano en cualquier parte de la nota; el dedo, el ratón y el teclado siguen igual. */
function inkPenPlugin() {
  return new Plugin<boolean>({
    key: penModeKey,
    state: {
      init: () => false,
      apply: (tr, penMode) => tr.getMeta(penModeKey) ?? penMode,
    },
    props: {
      // Mientras se usa el lápiz la nota no es editable ni tiene el foco: así Scribble no tiene dónde
      // convertir los trazos en texto. El dedo o el ratón la vuelven editable.
      editable: (state) => !penModeKey.getState(state),
    },
    view(view) {
      const setPenMode = (on: boolean) => {
        if (penModeKey.getState(view.state) === on) return
        view.dispatch(view.state.tr.setMeta(penModeKey, on).setMeta('addToHistory', false))
        const active = document.activeElement
        if (on && active instanceof HTMLElement && view.dom.contains(active)) active.blur()
      }
      // Sin esto Safari desplaza la nota con el lápiz.
      const onTouch = (e: TouchEvent) => {
        const stylus = Array.from(e.changedTouches).some(
          (t) => (t as Touch & { touchType?: string }).touchType === 'stylus',
        )
        if (stylus && penWrites(e.target)) e.preventDefault()
      }
      const onPointerDown = (e: PointerEvent) => {
        const writes = e.pointerType === 'pen' && penWrites(e.target)
        setPenMode(writes)
        // Si cae sobre un bloque, el bloque ya sigue el trazo.
        if (!writes || e.defaultPrevented) return
        e.preventDefault()
        startInk(view, e)
      }
      // Lápiz flotando sobre la nota (iPad con hover): se prepara antes de tocar la pantalla.
      const onPointerMove = (e: PointerEvent) => {
        if (e.pointerType === 'pen' && e.buttons === 0 && penWrites(e.target)) setPenMode(true)
      }
      view.dom.addEventListener('touchstart', onTouch, { passive: false })
      view.dom.addEventListener('touchmove', onTouch, { passive: false })
      view.dom.addEventListener('pointerdown', onPointerDown)
      view.dom.addEventListener('pointermove', onPointerMove)
      return {
        destroy() {
          view.dom.removeEventListener('touchstart', onTouch)
          view.dom.removeEventListener('touchmove', onTouch)
          view.dom.removeEventListener('pointerdown', onPointerDown)
          view.dom.removeEventListener('pointermove', onPointerMove)
        },
      }
    },
  })
}

/** Bloque de escritura a mano: los trazos van en la propia nota, en unidades independientes del ancho. */
export const Ink = Node.create({
  name: 'ink',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      strokes: {
        default: [],
        parseHTML: (el) => parseStrokes(el.getAttribute('data-strokes')),
        renderHTML: (attrs) => ({ 'data-strokes': JSON.stringify(attrs.strokes) }),
      },
      height: {
        default: INK_DEFAULT_HEIGHT,
        parseHTML: (el) => Number(el.getAttribute('data-height')) || INK_DEFAULT_HEIGHT,
        renderHTML: (attrs) => ({ 'data-height': attrs.height }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="ink"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'ink' })]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => new InkView(node, editor.view, getPos)
  },

  addProseMirrorPlugins() {
    return [inkPenPlugin()]
  },
})
