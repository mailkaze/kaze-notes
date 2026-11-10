import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceAuthError, verifyDeviceUser } from './deviceAuth'
import type { AppUser } from './types'

const user: AppUser = { uid: 'u1', name: 'Kaze', email: 'kaze@example.com', photoURL: null }

/** Datos del autenticador: 32 bytes de hash del rpId, flags (UP = 0x01, UV = 0x04) y contador. */
function authData(verified: boolean): ArrayBuffer {
  const bytes = new Uint8Array(37)
  bytes[32] = verified ? 0x05 : 0x01
  return bytes.buffer
}

const rawId = new Uint8Array([1, 2, 3]).buffer
const create = vi.fn()
const get = vi.fn()
const platformAvailable = vi.fn(async () => true)

beforeEach(() => {
  localStorage.clear()
  create.mockReset().mockResolvedValue({ rawId, response: { getAuthenticatorData: () => authData(true) } })
  get.mockReset().mockResolvedValue({ rawId, response: { authenticatorData: authData(true) } })
  platformAvailable.mockReset().mockResolvedValue(true)
  vi.stubGlobal('PublicKeyCredential', { isUserVerifyingPlatformAuthenticatorAvailable: platformAvailable })
  Object.defineProperty(navigator, 'credentials', { value: { create, get }, configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verifyDeviceUser', () => {
  it('registers this device the first time, then asks it to verify the user with that credential', async () => {
    await verifyDeviceUser(user)
    expect(create).toHaveBeenCalledTimes(1)
    const options = create.mock.calls[0][0].publicKey
    expect(options.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'platform', userVerification: 'required' })
    expect(get).not.toHaveBeenCalled()

    await verifyDeviceUser(user)
    expect(create).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(1)
    const request = get.mock.calls[0][0].publicKey
    expect(request.userVerification).toBe('required')
    expect([...new Uint8Array(request.allowCredentials[0].id)]).toEqual([1, 2, 3])
  })

  it('rejects when the device did not verify the user', async () => {
    await verifyDeviceUser(user)
    get.mockResolvedValue({ rawId, response: { authenticatorData: authData(false) } })
    await expect(verifyDeviceUser(user)).rejects.toBeInstanceOf(DeviceAuthError)
  })

  it('does not remember a registration that skipped user verification', async () => {
    create.mockResolvedValue({ rawId, response: { getAuthenticatorData: () => authData(false) } })
    await expect(verifyDeviceUser(user)).rejects.toBeInstanceOf(DeviceAuthError)
    create.mockResolvedValue({ rawId, response: { getAuthenticatorData: () => authData(true) } })
    await verifyDeviceUser(user)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('reports a cancelled prompt as cancelled', async () => {
    await verifyDeviceUser(user)
    get.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'))
    const error = await verifyDeviceUser(user).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeviceAuthError)
    expect((error as DeviceAuthError).cancelled).toBe(true)
  })

  it('explains a failed registration on a device without biometrics or screen lock, and remembers nothing', async () => {
    platformAvailable.mockResolvedValue(false)
    create.mockRejectedValue(new DOMException('no authenticator', 'NotAllowedError'))
    const error = await verifyDeviceUser(user).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeviceAuthError)
    expect((error as DeviceAuthError).cancelled).toBe(false)
    await verifyDeviceUser(user).catch(() => undefined)
    expect(get).not.toHaveBeenCalled()
  })

  it('reports a cancelled registration as cancelled when the device supports it', async () => {
    create.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'))
    const error = await verifyDeviceUser(user).catch((e: unknown) => e)
    expect((error as DeviceAuthError).cancelled).toBe(true)
  })

  it('registers the device again when asked, replacing the previous credential', async () => {
    await verifyDeviceUser(user)
    create.mockResolvedValue({ rawId: new Uint8Array([9]).buffer, response: { getAuthenticatorData: () => authData(true) } })
    await verifyDeviceUser(user, { reregister: true })
    expect(create).toHaveBeenCalledTimes(2)

    await verifyDeviceUser(user)
    expect([...new Uint8Array(get.mock.calls[0][0].publicKey.allowCredentials[0].id)]).toEqual([9])
  })

  it('shares one prompt between overlapping calls', async () => {
    await Promise.all([verifyDeviceUser(user), verifyDeviceUser(user)])
    expect(create).toHaveBeenCalledTimes(1)
  })
})
