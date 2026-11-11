// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAllCaches, clearCachedFiles } from './registerServiceWorker'
import { renderServiceWorker } from './swBuild'

// Ejecuta la plantilla real de sw.js con CacheStorage, fetch y eventos de mentira.

const ORIGIN = 'https://notes.test'
const TEMPLATE = readFileSync(new URL('./sw.js', import.meta.url), 'utf8')
const FILE = 'https://firebasestorage.googleapis.com/v0/b/kaze.appspot.com/o/u1%2Fa.png?alt=media&token=t1'

type Req = string | { url: string }
type Res = Response | { type: 'opaque'; ok: false; status: 0; clone(): Res }

const absolute = (r: Req) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href

/** Red y CacheStorage en memoria; las cachés se listan en orden de creación, como en el navegador. */
function createWorld() {
  const network = new Map<string, () => Res>()
  const stores = new Map<string, Map<string, Res>>()
  const fetch = vi.fn(async (r: Req) => {
    const respond = network.get(absolute(r))
    if (!respond) throw new TypeError('Failed to fetch')
    return respond()
  })
  const cacheOf = (name: string) => {
    const entries = stores.get(name) ?? new Map<string, Res>()
    stores.set(name, entries)
    return {
      match: async (r: Req) => entries.get(absolute(r))?.clone(),
      put: async (r: Req, response: Res) => void entries.set(absolute(r), response),
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      delete: async (r: Req) => entries.delete(absolute(r)),
      addAll: async (requests: Req[]) => {
        for (const r of requests) {
          const response = await fetch(r)
          if (!response.ok) throw new TypeError('addAll')
          entries.set(absolute(r), response)
        }
      },
    }
  }
  const caches = {
    open: async (name: string) => cacheOf(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: Req, options: { cacheName: string }) => stores.get(options.cacheName)?.get(absolute(r))?.clone(),
  }
  return {
    fetch,
    caches,
    stores,
    serve: (url: string, body = `net ${absolute(url)}`, status = 200) => network.set(absolute(url), () => new Response(body, { status })),
    serveOpaque: (url: string) => {
      const opaque: Res = { type: 'opaque', ok: false, status: 0, clone: () => opaque }
      network.set(absolute(url), () => opaque)
    },
    serves: (url: string) => network.has(absolute(url)),
    offline: () => network.clear(),
    cached: (name: string) => [...(stores.get(name)?.keys() ?? [])],
  }
}

type World = ReturnType<typeof createWorld>

class FakeRequest {
  url: string
  cache?: string
  constructor(url: string, init?: { cache?: string }) {
    this.url = absolute(url)
    this.cache = init?.cache
  }
}

function startWorker(world: World, version: string, urls: string[]) {
  const listeners = new Map<string, (event: object) => void>()
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: object) => void) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  }
  new Function('self', 'caches', 'fetch', 'Request', renderServiceWorker(TEMPLATE, { version, urls }))(
    self,
    world.caches,
    world.fetch,
    FakeRequest,
  )
  const extend = async (type: string) => {
    const pending: Promise<unknown>[] = []
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => pending.push(p) })
    await Promise.all(pending)
  }
  return {
    self,
    install: () => extend('install'),
    activate: () => extend('activate'),
    /** Respuesta del service worker, o `undefined` si deja pasar la petición sin tocarla. */
    async request(url: string, { method = 'GET', mode = 'no-cors', headers = {} } = {}): Promise<Res | undefined> {
      let responded: Promise<Res> | undefined
      const pending: Promise<unknown>[] = []
      listeners.get('fetch')!({
        request: { url: absolute(url), method, mode, headers: new Headers(headers) },
        respondWith: (p: Promise<Res>) => (responded = p),
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      })
      if (!responded) return undefined
      const response = await responded
      await Promise.all(pending)
      return response
    },
  }
}

async function installed(world: World, version: string, urls: string[]) {
  urls.filter((url) => !world.serves(url)).forEach((url) => world.serve(url))
  const worker = startWorker(world, version, urls)
  await worker.install()
  await worker.activate()
  return worker
}

const text = async (response: Res | undefined) => (response instanceof Response ? response.text() : undefined)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('service worker', () => {
  it('precaches the whole app without the HTTP cache and takes over at once', async () => {
    const world = createWorld()
    const urls = ['/index.html', '/assets/index-a1.js', '/assets/NoteEditor-b2.js', '/manifest.webmanifest']
    urls.forEach((url) => world.serve(url))
    const worker = startWorker(world, 'v1', urls)
    await worker.install()
    expect(world.cached('kaze-shell-v1')).toEqual(urls.map(absolute))
    expect(world.fetch.mock.calls.map(([r]) => (r as FakeRequest).cache)).toEqual(urls.map(() => 'no-cache'))
    expect(worker.self.skipWaiting).toHaveBeenCalled()
  })

  it('leaves no partial copy when a file cannot be downloaded', async () => {
    const world = createWorld()
    world.serve('/index.html')
    const worker = startWorker(world, 'v1', ['/index.html', '/assets/index-a1.js'])
    await expect(worker.install()).rejects.toThrow()
    expect(world.stores.has('kaze-shell-v1')).toBe(false)
    expect(worker.self.skipWaiting).not.toHaveBeenCalled()
  })

  it('keeps the current and the previous version on activation, and never the downloaded files', async () => {
    const world = createWorld()
    await installed(world, 'v1', ['/index.html'])
    world.stores.set('kaze-files', new Map())
    await installed(world, 'v2', ['/index.html'])
    const worker = await installed(world, 'v3', ['/index.html'])
    expect([...world.stores.keys()]).toEqual(['kaze-files', 'kaze-shell-v2', 'kaze-shell-v3'])
    expect(worker.self.clients.claim).toHaveBeenCalled()
  })

  it('opens the saved app on every navigation, even with network, and uses the network only without a copy', async () => {
    const world = createWorld()
    const worker = await installed(world, 'v1', ['/index.html'])
    world.serve('/otra/ruta', 'from network')
    world.fetch.mockClear()
    expect(await text(await worker.request('/otra/ruta', { mode: 'navigate' }))).toBe('net https://notes.test/index.html')
    expect(world.fetch).not.toHaveBeenCalled()

    const empty = createWorld()
    empty.serve('/otra/ruta', 'from network')
    expect(await text(await startWorker(empty, 'v1', []).request('/otra/ruta', { mode: 'navigate' }))).toBe('from network')
  })

  it('serves the current files first and still the previous version code offline', async () => {
    const world = createWorld()
    world.serve('/favicon.svg', 'icon v1')
    await installed(world, 'v1', ['/index.html', '/assets/NoteEditor-old.js', '/favicon.svg'])
    world.serve('/favicon.svg', 'icon v2')
    const worker = await installed(world, 'v2', ['/index.html', '/assets/NoteEditor-new.js', '/favicon.svg'])
    world.offline()
    expect(await text(await worker.request('/assets/NoteEditor-old.js', { mode: 'cors' }))).toBe(
      'net https://notes.test/assets/NoteEditor-old.js',
    )
    expect(await text(await worker.request('/favicon.svg'))).toBe('icon v2')
  })

  it('asks the network for same-origin files it does not have', async () => {
    const world = createWorld()
    const worker = await installed(world, 'v1', ['/index.html'])
    world.serve('/robots.txt', 'robots')
    expect(await text(await worker.request('/robots.txt'))).toBe('robots')
    world.offline()
    await expect(worker.request('/robots.txt')).rejects.toThrow()
  })

  it('leaves Firebase, other origins and non-GET requests alone', async () => {
    const worker = await installed(createWorld(), 'v1', ['/index.html'])
    const untouched = [
      worker.request('/__/auth/handler?apiKey=k', { mode: 'navigate' }),
      worker.request('/__/firebase/init.json'),
      worker.request('/sw.js'),
      worker.request('/index.html', { method: 'POST' }),
      worker.request('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?VER=8'),
      worker.request('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k', { method: 'POST' }),
      worker.request('https://securetoken.googleapis.com/v1/token?key=k'),
      worker.request('https://apis.google.com/js/api.js'),
      worker.request('https://example.com/a.png'),
      worker.request(FILE.replace('alt=media&', '')),
      worker.request(FILE, { headers: { range: 'bytes=0-' } }),
    ]
    expect(await Promise.all(untouched)).toEqual(untouched.map(() => undefined))
  })

  it('keeps downloaded attachments to show them offline', async () => {
    const world = createWorld()
    const worker = await installed(world, 'v1', ['/index.html'])
    world.serve(FILE, 'png')
    expect(await text(await worker.request(FILE))).toBe('png')
    world.offline()
    expect(await text(await worker.request(FILE))).toBe('png')
    expect(world.cached('kaze-files')).toEqual([FILE])
  })

  it('keeps opaque downloads but never an error', async () => {
    const world = createWorld()
    const worker = await installed(world, 'v1', ['/index.html'])
    const denied = FILE.replace('a.png', 'b.png')
    world.serveOpaque(FILE)
    world.serve(denied, 'denied', 403)
    expect((await worker.request(FILE))?.type).toBe('opaque')
    expect((await worker.request(denied))?.status).toBe(403)
    expect(world.cached('kaze-files')).toEqual([FILE])
  })

  it('keeps only the latest 100 downloaded files, so they never crowd out the notes saved offline', async () => {
    const world = createWorld()
    const worker = await installed(world, 'v1', ['/index.html'])
    const files = Array.from({ length: 102 }, (_, i) => FILE.replace('a.png', `${i}.png`))
    for (const file of files) {
      world.serveOpaque(file)
      await worker.request(file)
    }
    expect(world.cached('kaze-files')).toEqual(files.slice(2))
  })

  it('stops keeping downloaded files when the app already uses half of its storage quota', async () => {
    const world = createWorld()
    const worker = await installed(world, 'v1', ['/index.html'])
    Object.assign(worker.self, { navigator: { storage: { estimate: async () => ({ usage: 60, quota: 100 }) } } })
    world.serveOpaque(FILE)
    expect((await worker.request(FILE))?.type).toBe('opaque')
    expect(world.cached('kaze-files')).toEqual([])
  })

  it('clears the downloaded files alone, or every app cache', async () => {
    const world = createWorld()
    await installed(world, 'v1', ['/index.html'])
    world.stores.set('kaze-files', new Map())
    world.stores.set('other-app', new Map())
    vi.stubGlobal('caches', world.caches)
    await clearCachedFiles()
    expect([...world.stores.keys()]).toEqual(['kaze-shell-v1', 'other-app'])
    world.stores.set('kaze-files', new Map())
    await clearAllCaches()
    expect([...world.stores.keys()]).toEqual(['other-app'])
  })
})
