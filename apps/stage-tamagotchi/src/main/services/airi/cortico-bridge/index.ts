import type { CorticoBridgeFrame, CorticoBridgeState } from '../../../../shared/eventa/cortico-bridge'

import { useLogg } from '@guiiai/logg'

/**
 * 与 Cortico 的 console World 保持一条长连接。
 *
 * ## 为什么必须常驻连接
 * Cortico 的 console World 把消息**广播给当时在线的连接**（`world.ts` 的 `broadcastSys`
 * 与 `deliver`）。脚本式「连上、发一句、等回复、断开」会漏回复：发出去之后模型要想几秒，
 * 那时我们若已退出名单就再也收不到。所以这里维持一条长期 socket。
 *
 * ## 为什么在主进程连
 * renderer 跑在 `file://` 下（Origin: null），Cortico 的 `isForeignOrigin` 把 `'null'`
 * 直接判为跨站，在 upgrade 阶段 `socket.destroy()`。Node 的 WebSocket 不发 Origin 头，
 * 走的是「缺 Origin 则放行」那条分支。因此连接放在主进程，通过 eventa 桥给渲染进程。
 *
 * ## 协议（Cortico `src/worlds/console/world.ts` 头部注释）
 * 客户端 → `{type:'hello', name}`（必须先于 msg）、`{type:'msg', text}`、`{type:'greet'}`
 * 服务端 → `{type:'msg', from, text, ts, images?}`、`{type:'sys', text, kind?}`
 */

const log = useLogg('cortico-bridge').useGlobalConfig()

/** console World 的 WebSocket 路径（`world:console` 必须 URL 编码） */
const CONSOLE_WS_PATH = '/ws/providers/world%3Aconsole/panels/chat'

/** 断线重连的退避上限 */
const RECONNECT_MAX_MS = 30_000
/** 首次重连延迟 */
const RECONNECT_MIN_MS = 1_000

export interface CorticoBridgeOptions {
  port?: number
  /** 报给 Cortico 的名字，会显示在控制台里 */
  name?: string
}

type FrameListener = (frame: CorticoBridgeFrame) => void
type StateListener = (state: CorticoBridgeState) => void

export class CorticoBridge {
  private readonly port: number
  private readonly name: string

  private socket: WebSocket | null = null
  private state: CorticoBridgeState
  private frameListeners = new Set<FrameListener>()
  private stateListeners = new Set<StateListener>()

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = RECONNECT_MIN_MS
  /** 用户主动断开时不再自动重连 */
  private wanted = false
  private disposed = false

  constructor(options: CorticoBridgeOptions = {}) {
    this.port = options.port ?? 7788
    this.name = options.name ?? 'AIRI'
    this.state = { state: 'disconnected', port: this.port, name: this.name }
  }

  getState(): CorticoBridgeState {
    return { ...this.state }
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** 连上并保持。已连接时是空操作。 */
  connect(): CorticoBridgeState {
    this.wanted = true
    if (this.state.state === 'online' || this.state.state === 'connecting')
      return this.getState()

    this.openSocket()
    return this.getState()
  }

  /** 主动断开，且不再自动重连。 */
  disconnect(): CorticoBridgeState {
    this.wanted = false
    this.clearReconnect()
    this.closeSocket()
    this.setState({ state: 'disconnected', port: this.port, name: this.name })
    return this.getState()
  }

  /**
   * 发一条用户消息。未连接时返回失败而不是抛错，让调用方能显示提示。
   */
  send(text: string): { ok: true } | { ok: false, error: string } {
    const trimmed = text.trim()
    if (!trimmed)
      return { ok: false, error: '消息为空' }

    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return { ok: false, error: '尚未连接到 Cortico' }

    try {
      socket.send(JSON.stringify({ type: 'msg', text: trimmed }))
      return { ok: true }
    }
    catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  dispose(): void {
    this.disposed = true
    this.wanted = false
    this.clearReconnect()
    this.closeSocket()
    this.frameListeners.clear()
    this.stateListeners.clear()
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private openSocket(): void {
    this.closeSocket()
    this.setState({ state: 'connecting', port: this.port, name: this.name })

    const url = `ws://127.0.0.1:${this.port}${CONSOLE_WS_PATH}`
    log.log(`connecting to ${url}`)

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ state: 'disconnected', port: this.port, name: this.name, lastError: message })
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      if (this.socket !== socket)
        return
      this.reconnectDelay = RECONNECT_MIN_MS
      // 必须先报名字，否则后续 msg 会被 reject(helloFirst)
      socket.send(JSON.stringify({ type: 'hello', name: this.name }))
      this.setState({ state: 'online', port: this.port, name: this.name })
      log.log('bridge online')
    })

    socket.addEventListener('message', (event: MessageEvent) => {
      if (this.socket !== socket)
        return
      this.handleFrame(event.data)
    })

    socket.addEventListener('error', () => {
      if (this.socket !== socket)
        return
      // Event 对象里没有可用的错误文本，只记一句；详情靠 close/重连本身体现
      log.warn('bridge socket error')
    })

    socket.addEventListener('close', () => {
      if (this.socket !== socket)
        return
      this.socket = null
      if (this.disposed)
        return
      this.setState({
        state: 'disconnected',
        port: this.port,
        name: this.name,
        lastError: '连接已断开',
      })
      if (this.wanted)
        this.scheduleReconnect()
    })
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') {
      // Node 的 WebSocket 可能给 Buffer/ArrayBuffer
      if (raw instanceof ArrayBuffer)
        this.handleFrame(new TextDecoder().decode(raw))
      else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw))
        this.handleFrame(raw.toString('utf8'))
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      log.warn('drop malformed frame')
      return
    }
    if (!parsed || typeof parsed !== 'object')
      return

    const frame = parsed as Record<string, unknown>
    const type = frame.type

    if (type === 'msg') {
      if (typeof frame.text !== 'string')
        return
      this.emitFrame({
        kind: 'msg',
        text: frame.text,
        from: typeof frame.from === 'string' ? frame.from : null,
        ts: typeof frame.ts === 'number' ? frame.ts : Date.now(),
        history: frame.history === true,
      })
      return
    }

    if (type === 'sys') {
      if (typeof frame.text !== 'string')
        return
      const sysKind = frame.kind === 'rejected' || frame.kind === 'warning' ? frame.kind : undefined
      this.emitFrame({
        kind: 'sys',
        text: frame.text,
        from: null,
        ts: Date.now(),
        ...(sysKind ? { sysKind } : {}),
      })
    }
  }

  private emitFrame(frame: CorticoBridgeFrame): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame)
      }
      catch (error) {
        log.withError(error).warn('frame listener threw')
      }
    }
  }

  private setState(next: CorticoBridgeState): void {
    this.state = next
    const snapshot = this.getState()
    for (const listener of this.stateListeners) {
      try {
        listener(snapshot)
      }
      catch (error) {
        log.withError(error).warn('state listener threw')
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.wanted || this.reconnectTimer)
      return

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    log.log(`reconnect in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed || !this.wanted)
        return
      this.openSocket()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectDelay = RECONNECT_MIN_MS
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket)
      return
    try {
      socket.close()
    }
    catch {}
  }
}
