import { t } from './i18n'
import type { AppUser } from './types'

/**
 * Verificación del usuario con el bloqueo del propio dispositivo (huella, Face ID, patrón, PIN…) mediante WebAuthn.
 * Solo protege la interfaz: no hay servidor que compruebe la firma, basta con que el sistema confirme al usuario.
 */

/** Error de verificación; `cancelled` si el usuario cerró el aviso (no hace falta mostrar nada). */
export class DeviceAuthError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message)
    this.name = 'DeviceAuthError'
  }
}

const storageKey = (uid: string) => `kaze:deviceCredential:${uid}`

function readCredential(uid: string): string | null {
  try {
    return localStorage.getItem(storageKey(uid))
  } catch {
    return null
  }
}

function saveCredential(uid: string, id: string) {
  try {
    localStorage.setItem(storageKey(uid), id)
  } catch {
    // Sin almacenamiento: se volverá a registrar el dispositivo la próxima vez.
  }
}

function toBase64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** Bit UV de los flags (byte 32 de los datos del autenticador): el sistema ha verificado al usuario. */
function userVerified(authenticatorData: ArrayBuffer | undefined): boolean {
  const bytes = new Uint8Array(authenticatorData ?? new ArrayBuffer(0))
  return bytes.length > 32 && (bytes[32] & 0x04) !== 0
}

const challenge = () => crypto.getRandomValues(new Uint8Array(32))

const unsupported = () =>
  new DeviceAuthError(
    t(
      'This device has no fingerprint, face or screen lock available for this app.',
      'Este dispositivo no tiene huella, reconocimiento facial ni bloqueo de pantalla disponibles para esta app.',
    ),
  )

const notVerified = () => new DeviceAuthError(t('The device did not verify your identity.', 'El dispositivo no ha verificado tu identidad.'))

/** Sin huella, cara ni bloqueo de pantalla, el fallo se explica como tal en vez de como una cancelación. */
async function explainFailure(error: unknown): Promise<never> {
  const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false)
  throw available ? error : unsupported()
}

async function register(user: AppUser) {
  // create() se llama sin esperar nada antes: Safari solo lo permite dentro del gesto del usuario.
  const credential = (await navigator.credentials
    .create({
    publicKey: {
      rp: { name: 'Kaze Notes' },
      // Mismo id de usuario siempre: al registrar de nuevo, el sistema reemplaza la credencial anterior.
      user: {
        id: new TextEncoder().encode(user.uid),
        name: user.email ?? user.uid,
        displayName: user.name ?? user.email ?? 'Kaze Notes',
      },
      challenge: challenge(),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 60_000,
    },
  })
    .catch(explainFailure)) as PublicKeyCredential | null
  if (!credential) throw notVerified()
  const response = credential.response as AuthenticatorAttestationResponse
  // Navegadores antiguos sin getAuthenticatorData: se confía en userVerification: 'required'.
  if (typeof response.getAuthenticatorData === 'function' && !userVerified(response.getAuthenticatorData())) {
    throw notVerified()
  }
  saveCredential(user.uid, toBase64Url(credential.rawId))
}

async function assertUser(credentialId: string) {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: challenge(),
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null
  if (!credential) throw notVerified()
  if (!userVerified((credential.response as AuthenticatorAssertionResponse).authenticatorData)) throw notVerified()
}

function toDeviceAuthError(error: unknown): DeviceAuthError {
  if (error instanceof DeviceAuthError) return error
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new DeviceAuthError(t('Verification cancelled.', 'Verificación cancelada.'), true)
  }
  if (name === 'NotSupportedError' || name === 'SecurityError') return unsupported()
  const detail = error instanceof Error ? error.message : String(error)
  return new DeviceAuthError(t(`Could not verify: ${detail}`, `No se ha podido verificar: ${detail}`))
}

async function verify(user: AppUser, reregister: boolean) {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) throw unsupported()
  const stored = readCredential(user.uid)
  if (stored && !reregister) await assertUser(stored)
  else await register(user)
}

let pending: { promise: Promise<void>; reregister: boolean } | null = null

/**
 * Pide al sistema que verifique al usuario. La primera vez (o con `reregister`) registra este dispositivo,
 * lo que también exige verificarse. Las llamadas que se solapan comparten el mismo aviso.
 */
export function verifyDeviceUser(user: AppUser, options: { reregister?: boolean } = {}): Promise<void> {
  const reregister = Boolean(options.reregister)
  // Volver a registrar durante otra verificación: si esa sale bien ya basta; si falla, se registra después.
  if (pending && reregister && !pending.reregister) return pending.promise.catch(() => verifyDeviceUser(user, options))
  if (!pending) {
    const current = {
      reregister,
      promise: verify(user, reregister)
        .catch((error: unknown) => {
          throw toDeviceAuthError(error)
        })
        .finally(() => {
          if (pending === current) pending = null
        }),
    }
    pending = current
  }
  return pending.promise
}
