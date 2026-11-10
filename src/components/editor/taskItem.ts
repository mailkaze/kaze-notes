import { TaskItem } from '@tiptap/extension-list'
import type { NodeViewRendererProps } from '@tiptap/core'
import { t } from '../../lib/i18n'
import { startTaskDrag } from './taskDrag'

// Icono GripVertical de lucide, en SVG plano porque la vista del nodo no es de React.
const GRIP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>'

/** Casilla de verificación con un asa para reordenarla arrastrando dentro de su lista. */
export const ReorderableTaskItem = TaskItem.extend({
  addNodeView() {
    const parent = this.parent?.()
    if (!parent) return null
    return (props: NodeViewRendererProps) => {
      const view = parent(props)
      const grip = document.createElement('span')
      grip.className = 'task-grip'
      grip.contentEditable = 'false'
      grip.title = t('Drag to reorder', 'Arrastra para reordenar')
      grip.innerHTML = GRIP_SVG
      grip.addEventListener('pointerdown', (event) => {
        const getPos = typeof props.getPos === 'function' ? props.getPos : () => undefined
        startTaskDrag(event, props.editor.view, getPos)
      })
      view.dom.insertBefore(grip, view.dom.firstChild)
      return {
        ...view,
        // ProseMirror no debe tratar los eventos del asa (selección, foco).
        stopEvent: (event: Event) => grip.contains(event.target as globalThis.Node),
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' && grip.contains(mutation.target),
      }
    }
  },
})
