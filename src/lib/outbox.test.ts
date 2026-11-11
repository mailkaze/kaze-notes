import { afterEach, describe, expect, it } from 'vitest'
import { clearOutbox, deleteUpload, getUpload, listUploads, pendingUploadCount, saveUpload, type OutboxEntry } from './outbox'

// jsdom no tiene IndexedDB: se prueba la cola en memoria, que sigue el mismo contrato.

function entry(id: string, uid: string, createdAt: number): OutboxEntry {
  const blob = new Blob([`contenido ${id}`], { type: 'application/pdf' })
  return { id, uid, noteId: 'n1', blob, name: `${id}.pdf`, type: blob.type, size: blob.size, createdAt }
}

afterEach(() => clearOutbox())

describe('upload outbox', () => {
  it('without IndexedDB keeps the file for this tab only and says it would not survive a reload', async () => {
    expect(await saveUpload(entry('a', 'u1', 1))).toBe(false)
    expect((await getUpload('a'))?.name).toBe('a.pdf')
  })

  it('lists the files of one user, oldest first, until each one is deleted', async () => {
    await saveUpload(entry('b', 'u1', 20))
    await saveUpload(entry('a', 'u1', 10))
    await saveUpload(entry('c', 'u2', 5))
    expect((await listUploads('u1')).map((e) => e.id)).toEqual(['a', 'b'])

    await deleteUpload('a')
    expect((await listUploads('u1')).map((e) => e.id)).toEqual(['b'])
    expect(await getUpload('a')).toBeUndefined()
  })

  it('counts pending files of one user or of everyone, and clearing empties it for all users', async () => {
    await saveUpload(entry('a', 'u1', 1))
    await saveUpload(entry('b', 'u1', 2))
    await saveUpload(entry('c', 'u2', 3))
    expect(await pendingUploadCount('u1')).toBe(2)
    expect(await pendingUploadCount()).toBe(3)

    await clearOutbox()
    expect(await pendingUploadCount()).toBe(0)
    expect(await listUploads('u2')).toEqual([])
  })

  it('tells other tabs a file left the queue only when it really left the shared queue', async () => {
    const heard: unknown[] = []
    const other = new BroadcastChannel('kaze-outbox')
    other.onmessage = (event) => heard.push(event.data)
    // Sin IndexedDB el fichero solo estaba en esta pestaña: las demás no tienen nada que olvidar.
    await deleteUpload('solo-aqui')
    await new Promise((resolve) => setTimeout(resolve, 20))
    other.close()
    expect(heard).toEqual([])
  })
})
