import type { Session } from 'electron'

import { useLogg } from '@guiiai/logg'

/**
 * Cortico 的 WebUI（默认监听 127.0.0.1:7788）不发送任何 CORS 头，
 * 而 AIRI 的渲染进程运行在 `file://` 下（Origin: null），
 * 所以从设置页里直接 `fetch('http://127.0.0.1:7788/api/...')` 会被 Chromium 拦掉。
 *
 * 这里在主进程的 onHeadersReceived 上给「发往本机 Cortico 端口」的响应补上
 * Access-Control-Allow-* 头。只放行本机回环地址，不改变 Cortico 自身的任何代码。
 */

const log = useLogg('cortico-cors').useGlobalConfig()

/** 允许跨域访问的本地主机名 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 判断某个 URL 是否属于「本机上的 Cortico」。
 * 只按回环地址 + 端口匹配，不限制路径，这样 /api/*、/ws/*、静态资源都能过。
 */
export function isLocalCorticoUrl(rawUrl: string, ports: number[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  }
  catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return false

  if (!LOCAL_HOSTS.has(parsed.hostname))
    return false

  const port = parsed.port
    ? Number(parsed.port)
    : (parsed.protocol === 'https:' ? 443 : 80)

  return ports.includes(port)
}

/**
 * 给响应头对象补上 CORS 字段。返回新的 headers（不改入参）。
 */
export function withCorsHeaders(
  headers: Record<string, string[]>,
): Record<string, string[]> {
  return {
    ...headers,
    'Access-Control-Allow-Origin': ['*'],
    'Access-Control-Allow-Methods': ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    'Access-Control-Allow-Headers': ['*'],
    'Access-Control-Max-Age': ['86400'],
  }
}

/**
 * 把 CORS 补丁挂到给定 session 上。默认端口 7788 与 Cortico 的 cormini bot 一致。
 *
 * 注意：只在 `app.whenReady()` 之后调用，且必须传入 `session.defaultSession`
 * （渲染进程走的就是它）。重复调用是幂等的：webRequest 监听器会被替换。
 */
export function setupCorticoCors(
  targetSession: Session,
  ports: number[] = [7788],
): void {
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {}

    if (!isLocalCorticoUrl(details.url, ports)) {
      callback({ responseHeaders })
      return
    }

    callback({ responseHeaders: withCorsHeaders(responseHeaders) })
  })

  log.log(`CORS shim installed for local ports: ${ports.join(', ')}`)
}
