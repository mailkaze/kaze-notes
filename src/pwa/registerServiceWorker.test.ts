import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Module = typeof import('./registerServiceWorker')

function fakeServiceWorker(controller: object | null) {
  const registration = { update: vi.fn(() => Promise.resolve()) }
  const container = Object.assign(new EventTarget(), {
    controller,
    register: vi.fn(() => Promise.resolve(registration)),
  })
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true })
  return { container, registration }
}

// Cada prueba con el módulo recién cargado: guarda si hay versión nueva.
async function load(): Promise<Module> {
  vi.resetModules()
  return import('./registerServiceWorker')
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.stubEnv('PROD', true)
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('registerServiceWorker', () => {
  it('does nothing outside a production build', async () => {
    vi.stubEnv('PROD', false)
    const { container } = fakeServiceWorker(null)
    ;(await load()).registerServiceWorker()
    expect(container.register).not.toHaveBeenCalled()
  })

  it('registers /sw.js in production', async () => {
    const { container } = fakeServiceWorker(null)
    ;(await load()).registerServiceWorker()
    expect(container.register).toHaveBeenCalledWith('/sw.js')
  })

  it('asks the browser not to evict the app data, which may hold changes not yet synced', async () => {
    fakeServiceWorker(null)
    const persist = vi.fn(() => Promise.resolve(true))
    Object.defineProperty(navigator, 'storage', { value: { persist }, configurable: true })
    ;(await load()).registerServiceWorker()
    expect(persist).toHaveBeenCalledOnce()
    Reflect.deleteProperty(navigator, 'storage')
  })

  it('announces a new version only when a worker takes over an already controlled page', async () => {
    const { container } = fakeServiceWorker(null)
    const sw = await load()
    const listener = vi.fn()
    sw.onUpdateReady(listener)
    sw.registerServiceWorker()
    // Primera instalación: toma el control, pero la página ya es la versión actual.
    container.dispatchEvent(new Event('controllerchange'))
    expect(sw.isUpdateReady()).toBe(false)
    container.dispatchEvent(new Event('controllerchange'))
    expect(sw.isUpdateReady()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()

    const controlled = fakeServiceWorker({})
    const reloaded = await load()
    reloaded.registerServiceWorker()
    controlled.container.dispatchEvent(new Event('controllerchange'))
    expect(reloaded.isUpdateReady()).toBe(true)
  })

  it('looks for a new version on every reconnection and on return to the tab at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const { registration } = fakeServiceWorker(null)
    ;(await load()).registerServiceWorker()
    await settle()
    const becomeVisible = () => document.dispatchEvent(new Event('visibilitychange'))

    vi.setSystemTime(30_000)
    becomeVisible()
    expect(registration.update).toHaveBeenCalledTimes(0)
    window.dispatchEvent(new Event('online'))
    expect(registration.update).toHaveBeenCalledTimes(1)
    vi.setSystemTime(60_000)
    becomeVisible()
    expect(registration.update).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('online'))
    expect(registration.update).toHaveBeenCalledTimes(2)
    vi.setSystemTime(120_000)
    becomeVisible()
    expect(registration.update).toHaveBeenCalledTimes(3)
  })
})
