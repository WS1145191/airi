import type { Session, User } from 'better-auth'

import { createAuthClient } from 'better-auth/vue'

import { SERVER_URL } from './server'
import { steamClient } from './steam-auth-client'

/** The shape `getSession` resolves with when the token is a live session. */
interface AuthSessionData {
  user: User
  session: Session
}

function getPersistedAuthToken(): string | null {
  return localStorage.getItem('auth/v1/token')
}

export const authClient = createAuthClient({
  baseURL: SERVER_URL,
  plugins: [steamClient()],
  fetchOptions: {
    // NOTICE: better-auth sets `credentials: "include"` by default.
    // AIRI uses Bearer authentication and must not attach a browser session cookie.
    credentials: 'omit',
    auth: {
      type: 'Bearer',
      token: () => getPersistedAuthToken() ?? '',
    },
  },
})

/**
 * Gets the session with the specified access token.
 *
 * The explicit token keeps the request independent from asynchronous storage writes.
 *
 * Returns the failure alongside the data. `data === null` alone cannot tell
 * "the server says this token is not a session" from "the request never
 * reached the server", and the two demand opposite handling: only the first
 * may drop the stored credentials. better-auth reports a status of `0` when
 * the fetch itself failed, and fills `error.status` from the response otherwise.
 */
export async function requestAuthSessionWithError(accessToken: string | null): Promise<{
  data: AuthSessionData | null
  failed: boolean
  status: number
}> {
  if (!accessToken)
    return { data: null, failed: true, status: 0 }

  const { data, error } = await authClient.getSession({
    fetchOptions: {
      auth: {
        type: 'Bearer',
        token: accessToken,
      },
    },
  })

  if (data)
    return { data, failed: false, status: 200 }

  const status = typeof (error as { status?: unknown } | undefined)?.status === 'number'
    ? (error as { status: number }).status
    : 0

  return { data: null, failed: true, status }
}

/**
 * Gets the session with the specified access token.
 *
 * The explicit token keeps the request independent from asynchronous storage writes.
 */
export async function requestAuthSession(accessToken: string | null): Promise<AuthSessionData | null> {
  const { data } = await requestAuthSessionWithError(accessToken)
  return data
}
