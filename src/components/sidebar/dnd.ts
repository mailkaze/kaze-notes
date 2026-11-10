import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'

/**
 * Sensores comunes: el ratón arrastra tras moverse 5 px; en táctil hay que mantener
 * pulsado 250 ms, así deslizar el dedo sigue haciendo scroll.
 */
export function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
}

// Solo hay un arrastre a la vez en toda la app.
let dragging = false
let endedAt = 0

export function dragStarted() {
  dragging = true
}

export function dragEnded() {
  dragging = false
  endedAt = Date.now()
}

/** true durante un arrastre y justo después: el click que sigue a soltar no debe abrir nada. */
export function justDragged(): boolean {
  return dragging || Date.now() - endedAt < 250
}
