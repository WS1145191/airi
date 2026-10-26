import type { Session, User } from 'better-auth'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { triggerSignIn } from '../libs/auth'
import { requestAuthSession } from '../libs/auth-client'
import { refreshAccessToken } from '../libs/auth-oidc'
import { useAuthStore } from './auth'

vi.mock('../libs/auth', () => ({
  triggerSignIn: vi.fn(),
}))

vi.mock('../libs/auth-client', () => ({
  authClient: {
    listSessions: vi.fn(),
  },
  requestAuthSession: vi.fn(),
}))

vi.mock('../libs/auth-oidc', () => ({
  refreshAccessToken: vi.fn(),
}))

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const user: User = {
  id: 'user-1',
  name: 'AIRI User',
  email: 'user@example.com',
  emailVerified: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
}

const session: Session = {
  id: 'session-1',
  token: 'server-session-token',
  userId: user.id,
  expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
}

describe('auth store sign-in requests', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    // Authentication also requests credits. Keep that HTTP boundary inside the test.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ flux: 0 })))
    setActivePinia(createPinia())
    vi.mocked(triggerSignIn).mockReset()
    vi.mocked(triggerSignIn).mockResolvedValue()
    vi.mocked(requestAuthSession).mockReset()
    vi.mocked(requestAuthSession).mockResolvedValue({ user, session })
    vi.mocked(refreshAccessToken).mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('allows sign-in to be requested again after an external flow is canceled', async () => {
    const authStore = useAuthStore()

    // ROOT CAUSE:
    //
    // Pocket remains mounted after launching the external login page. If the
    // user returns without authenticating, `needsLogin` used to remain true,
    // so a later click could not produce the transition that triggers sign-in.
    // Consuming each request restores the false -> true transition.
    authStore.needsLogin = true
    await nextTick()

    expect(triggerSignIn).toHaveBeenCalledTimes(1)
    expect(authStore.needsLogin).toBe(false)

    authStore.needsLogin = true
    await nextTick()

    expect(triggerSignIn).toHaveBeenCalledTimes(2)
    expect(authStore.needsLogin).toBe(false)
  })

  it('queries the session with the token from the completed sign-in', async () => {
    const authStore = useAuthStore()

    // ROOT CAUSE:
    //
    // The old callback queried the session through a raw localStorage read.
    // VueUse writes storage on the next microtask, so that request could use
    // the previous token and then clear the complete auth state.
    await authStore.completeSignIn({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      idToken: 'new-id-token',
      expiresIn: 3600,
      clientId: 'airi-stage-electron',
    })

    expect(requestAuthSession).toHaveBeenCalledWith('new-access-token')
    expect(authStore.token).toBe('new-access-token')
    expect(authStore.refreshToken).toBe('new-refresh-token')
    expect(authStore.idToken).toBe('new-id-token')
    expect(authStore.user).toEqual(user)
    expect(authStore.session).toEqual(session)
    expect(storage.getItem('auth/v1/token')).toBe('new-access-token')
    expect(storage.getItem('auth/v1/refresh-token')).toBe('new-refresh-token')
    expect(storage.getItem('auth/v1/oidc-id-token')).toBe('new-id-token')
    expect(storage.getItem('auth/v1/oidc-client-id')).toBe('airi-stage-electron')
    expect(storage.getItem('auth/v1/oidc-token-expiry')).not.toBeNull()

    await authStore.clearAllAuthState()
  })

  it('loads persisted credentials only when the store initializes', async () => {
    storage.values.set('auth/v1/token', 'persisted-access-token')
    storage.values.set('auth/v1/refresh-token', 'persisted-refresh-token')
    storage.values.set('auth/v1/oidc-id-token', 'persisted-id-token')
    storage.values.set('auth/v1/oidc-client-id', 'airi-stage-web')
    storage.values.set('auth/v1/oidc-token-expiry', String(Date.now() + 60_000))
    const authStore = useAuthStore()

    expect(authStore.token).toBeNull()

    await authStore.initialize()

    expect(requestAuthSession).toHaveBeenCalledWith('persisted-access-token')
    expect(authStore.token).toBe('persisted-access-token')
  })

  it('reads the capacitor percent and fallback choice with the Flux balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ flux: 5, capacitorPercent: 40, capacitorRechargesAt: '2026-10-11T06:00:00.000Z', fallbackToFlux: true })))
    const authStore = useAuthStore()
    authStore.$patch({ user, session })

    await authStore.updateCredits()

    expect(authStore.credits).toBe(5)
    expect(authStore.capacitorPercent).toBe(40)
    expect(authStore.capacitorRechargesAt).toBe('2026-10-11T06:00:00.000Z')
    expect(authStore.fallbackToFlux).toBe(true)
  })

  it('keeps the session when another window already rotated the refresh token', async () => {
    storage.values.set('auth/v1/token', 'spent-access-token')
    storage.values.set('auth/v1/refresh-token', 'spent-refresh-token')
    storage.values.set('auth/v1/oidc-id-token', 'old-id-token')
    storage.values.set('auth/v1/oidc-client-id', 'airi-stage-electron')
    storage.values.set('auth/v1/oidc-token-expiry', String(Date.now() - 60_000))
    const authStore = useAuthStore()

    // ROOT CAUSE:
    //
    // A refresh token can be redeemed once. Stage Tamagotchi runs several
    // renderers over one `localStorage`, and each initializes the store, so on a
    // restart they all refresh at the same moment. All but the first were told
    // `invalid_grant`, which used to be read as "the session ended" even though
    // a sibling renderer had just published a working token.
    vi.mocked(refreshAccessToken).mockImplementation(async () => {
      // The sibling renderer wins the race while this exchange is in flight.
      storage.values.set('auth/v1/token', 'fresh-access-token')
      storage.values.set('auth/v1/refresh-token', 'rotated-refresh-token')
      storage.values.set('auth/v1/oidc-token-expiry', String(Date.now() + 600_000))
      throw new Error('invalid_grant')
    })

    await authStore.initialize()

    expect(authStore.token).toBe('fresh-access-token')
    expect(authStore.refreshToken).toBe('rotated-refresh-token')
    expect(authStore.isAuthenticated).toBe(true)
    expect(storage.getItem('auth/v1/refresh-token')).toBe('rotated-refresh-token')
  })

  it('does not spend the refresh token when a sibling refreshed while waiting for the lock', async () => {
    storage.values.set('auth/v1/token', 'spent-access-token')
    storage.values.set('auth/v1/refresh-token', 'spent-refresh-token')
    storage.values.set('auth/v1/oidc-id-token', 'old-id-token')
    storage.values.set('auth/v1/oidc-client-id', 'airi-stage-electron')
    storage.values.set('auth/v1/oidc-token-expiry', String(Date.now() - 60_000))

    // ROOT CAUSE:
    //
    // Adopting the published credentials only works if there is something to
    // adopt at the moment the exchange starts. Two renderers starting together
    // both passed that check before either wrote, so both redeemed the same
    // token. The exchange now runs under a Web Lock and re-reads the storage
    // once the lock is held, so a renderer that waited behind a refresh adopts
    // its result instead of spending an already-redeemed token.
    let held = false
    vi.stubGlobal('navigator', {
      locks: {
        async request(_name: string, task: () => Promise<unknown>) {
          // Stand in for the sibling renderer publishing its rotation first.
          if (!held) {
            held = true
            storage.values.set('auth/v1/token', 'sibling-access-token')
            storage.values.set('auth/v1/refresh-token', 'sibling-refresh-token')
            storage.values.set('auth/v1/oidc-token-expiry', String(Date.now() + 600_000))
          }
          return await task()
        },
      },
    })

    const authStore = useAuthStore()
    await authStore.initialize()

    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(authStore.token).toBe('sibling-access-token')
    expect(authStore.refreshToken).toBe('sibling-refresh-token')
    expect(authStore.isAuthenticated).toBe(true)
  })

  it('still signs out when the refresh token is rejected and nobody replaced it', async () => {
    storage.values.set('auth/v1/token', 'spent-access-token')
    storage.values.set('auth/v1/refresh-token', 'spent-refresh-token')
    storage.values.set('auth/v1/oidc-id-token', 'old-id-token')
    storage.values.set('auth/v1/oidc-client-id', 'airi-stage-electron')
    storage.values.set('auth/v1/oidc-token-expiry', String(Date.now() - 60_000))
    const authStore = useAuthStore()

    vi.mocked(refreshAccessToken).mockRejectedValue(new Error('invalid_grant'))
    vi.useFakeTimers()

    try {
      const initializing = authStore.initialize()
      await vi.advanceTimersByTimeAsync(5_000)
      await initializing

      expect(authStore.token).toBeNull()
      expect(authStore.isAuthenticated).toBe(false)
      expect(storage.getItem('auth/v1/token')).toBeNull()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not persist state patches received from another window', async () => {
    const authStore = useAuthStore()

    // ROOT CAUSE:
    //
    // `useLocalStorage` observed every Pinia patch and wrote it to storage.
    // The storage event then reached another window, whose synced Pinia patch
    // wrote the same value back. This formed an unbounded cross-window loop.
    // Auth persistence now runs only inside auth commands.
    authStore.$patch({ token: 'synced-access-token' })
    await nextTick()

    expect(storage.values.size).toBe(0)
  })
})
