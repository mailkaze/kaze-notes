import { createFirebaseBackend } from './firebase'
import { createMemoryBackend } from './memory'
import type { Backend } from './types'

export type { Backend, SnapshotMeta, UploadResult, WriteOp } from './types'

function create(): { backend: Backend | null; backendError: string | null } {
  if (import.meta.env.VITE_BACKEND === 'memory') return { backend: createMemoryBackend(), backendError: null }
  try {
    return { backend: createFirebaseBackend(), backendError: null }
  } catch (error) {
    return { backend: null, backendError: error instanceof Error ? error.message : String(error) }
  }
}

/** Backend activo: Firebase por defecto, memoria local con `vite --mode memory`. */
export const { backend, backendError } = create()
