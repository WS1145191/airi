import { generateCodeChallenge, generateCodeVerifier, generateState } from '@proj-airi/stage-shared/auth'

import { SERVER_URL } from './server'

// OIDC Authorization Code + PKCE client for all platforms.

const OIDC_AUTHORIZE_PATH = '/api/auth/oauth2/authorize'
const OIDC_TOKEN_PATH = '/api/auth/oauth2/token'

/**
 * Deadline for one token exchange.
 *
 * Refreshing is what keeps a signed-in desktop app signed in for weeks. A
 * connection that hangs instead of failing used to hold the single in-flight
 * refresh open forever, so the refresh timer never ran again and the session
 * quietly died at the next expiry. Fifteen seconds is far above the latency
 * seen in practice (500–600 ms) and far below a user noticing.
 */
const REFRESH_TIMEOUT_MS = 15_000

export interface OIDCFlowParams {
  clientId: string
  redirectUri: string
  scopes?: string[]
  /**
   * Client secret — required when the OIDC client is registered as
   * confidential on the server. Omit for public clients.
   */
  clientSecret?: string
  /** Social provider hint — skips the server-side picker page. */
  provider?: 'google' | 'github' | 'steam'
}

export interface OIDCFlowState {
  codeVerifier: string
  state: string
}

/**
 * Build the full authorization URL and return the PKCE state that must be
 * persisted until the callback arrives.
 */
export async function buildAuthorizationURL(
  params: OIDCFlowParams,
): Promise<{ url: string, flowState: OIDCFlowState }> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = generateState()

  const scopes = params.scopes ?? ['openid', 'profile', 'email', 'offline_access']

  const url = new URL(OIDC_AUTHORIZE_PATH, SERVER_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', SERVER_URL)

  if (params.provider)
    url.searchParams.set('provider', params.provider)

  return {
    url: url.toString(),
    flowState: { codeVerifier, state },
  }
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  id_token?: string
  scope?: string
}

/**
 * The authorization server answered and refused the request.
 *
 * The distinction matters for refresh: a refusal of the credentials themselves
 * (400 `invalid_grant`, 401) means the session is really gone, while a refusal
 * of the *request* (500, 502, 503, rate limiting) means nothing about the
 * session. A network failure never reaches this class at all — `fetch` rejects
 * before a status exists. Callers must not delete credentials for anything but
 * the two statuses below.
 */
export class OIDCTokenRejectedError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`Token refresh failed: ${status} ${body}`)
    this.name = 'OIDCTokenRejectedError'
    this.status = status
    this.body = body
  }

  /**
   * Whether the server judged the credentials invalid rather than the request
   * malformed or the origin unavailable.
   */
  get isCredentialRejection(): boolean {
    return this.status === 400 || this.status === 401
  }
}

/**
 * A token request that produced no answer at all — offline, DNS, TLS, a proxy
 * that drops the connection, or a server that never responds. Says nothing
 * about whether the credentials are still valid.
 */
export function isTransientAuthFailure(error: unknown): boolean {
  if (error instanceof OIDCTokenRejectedError)
    return !error.isCredentialRejection
  // `fetch` rejects with TypeError('Failed to fetch') on network failure and
  // DOMException('TimeoutError') through the signal below.
  return true
}

/**
 * Exchange an authorization code for tokens (RFC 6749 S4.1.3).
 * Pure function — does NOT write to any store. Caller is responsible
 * for persisting the returned tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  flowState: OIDCFlowState,
  params: OIDCFlowParams,
  returnedState: string,
): Promise<TokenResponse> {
  if (returnedState !== flowState.state)
    throw new Error('OIDC state mismatch — possible CSRF attack')

  const bodyParams: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: flowState.codeVerifier,
    resource: SERVER_URL,
  }

  // Confidential clients must send the secret during token exchange.
  if (params.clientSecret)
    bodyParams.client_secret = params.clientSecret

  const body = new URLSearchParams(bodyParams)

  const response = await fetch(new URL(OIDC_TOKEN_PATH, SERVER_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Token exchange failed: ${response.status} ${error}`)
  }

  return await response.json()
}

/**
 * Refresh an access token using a refresh token (RFC 6749 S6).
 * Pure function — returns new tokens without writing to any store.
 */
export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource: SERVER_URL,
  }

  if (clientSecret)
    params.client_secret = clientSecret

  const body = new URLSearchParams(params)

  const response = await fetch(new URL(OIDC_TOKEN_PATH, SERVER_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    // Without a deadline a hung connection stalls the refresh until the OS
    // gives up, and the timer that scheduled it never reschedules: the session
    // silently stops refreshing instead of failing where it can be handled.
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })

  if (!response.ok)
    throw new OIDCTokenRejectedError(response.status, await response.text().catch(() => ''))

  return await response.json()
}

// Session storage keys for PKCE flow state (survives page navigation during OAuth)
const FLOW_STATE_KEY = 'auth/v1/oidc-flow-state'
const FLOW_PARAMS_KEY = 'auth/v1/oidc-flow-params'

/**
 * Persist OIDC flow state before navigating to the authorization server.
 */
export function persistFlowState(flowState: OIDCFlowState, params: OIDCFlowParams): void {
  sessionStorage.setItem(FLOW_STATE_KEY, JSON.stringify(flowState))
  sessionStorage.setItem(FLOW_PARAMS_KEY, JSON.stringify(params))
}

/**
 * Retrieve and clear persisted OIDC flow state after callback.
 */
export function consumeFlowState(): { flowState: OIDCFlowState, params: OIDCFlowParams } | null {
  const flowStateRaw = sessionStorage.getItem(FLOW_STATE_KEY)
  const paramsRaw = sessionStorage.getItem(FLOW_PARAMS_KEY)

  if (!flowStateRaw || !paramsRaw)
    return null

  sessionStorage.removeItem(FLOW_STATE_KEY)
  sessionStorage.removeItem(FLOW_PARAMS_KEY)

  return {
    flowState: JSON.parse(flowStateRaw),
    params: JSON.parse(paramsRaw),
  }
}
