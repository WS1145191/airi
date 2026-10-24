import type { CorticoBridgeDiag, CorticoBridgeFrame, CorticoBridgeState } from '../../../../shared/eventa/cortico-bridge'

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
/**
 * 一条消息广播回来被认作「自己发的回声」的时间窗。
 *
 * 控制台的广播是本地的，回声几乎立刻到；给足余量是因为模型可能先想几秒才回话，
 * 而我们要认的是**自己刚发出去那句**，不是它的回复。
 */
const ECHO_WINDOW_MS = 30_000

export interface CorticoBridgeOptions {
  port?: number
  /** 报给 Cortico 的名字，会显示在控制台里 */
  name?: string
}

/**
 * Cortico 当前的人格模式，取自它自己的 `config.json` 的 `mode` 字段。
 *
 * - `normal`：你问我答。AIRI 负责回答，Cortico 只记账 —— 转发过去的那条带 `silent`
 * - `work`：营业。Cortico 自己就是那个该说话的，转发不带 `silent`，由它回答
 */
export type CorticoMode = 'normal' | 'work'

/** 模式轮询间隔。配置改完要立刻反映到转发行为上，间隔留在十几秒的量级。 */
const MODE_POLL_MS = 15_000

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

  /**
   * 本桥接最近发出去的消息，用来认出控制台广播回来的那一句。
   *
   * 名字没法用来区分：bot 的 `from` 取的是 `cfg.displayName`，默认就是 `AIRI`，与这里报的名字
   * 相同。所以按「文本相同 + 在时间窗内」判定。
   */
  private readonly sent = new Map<string, number>()

  private framesIn = 0
  private msgIn = 0
  private echoIn = 0
  private framesOut = 0
  private viewers = 0

  /** 当前模式，默认普通（保守：先假设这边说话，避免一上电就双答）。 */
  private mode: CorticoMode = 'normal'
  private modeTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: CorticoBridgeOptions = {}) {
    this.port = options.port ?? 7788
    this.name = options.name ?? 'AIRI'
    this.state = { state: 'disconnected', port: this.port, name: this.name }
  }

  getState(): CorticoBridgeState {
    return { ...this.state, mode: this.mode }
  }

  /** 当前模式。`work` 时 Cortico 该自己回答，转发因此不能带 `silent`。 */
  getMode(): CorticoMode {
    return this.mode
  }

  /**
   * 从 Cortico 的 WebUI 读一次模式。
   *
   * 直接读 `GET /api/config`（公开 HTTP API，`docs/webui.md` 列出的那批之一），因为 Cortico
   * 的 mode 配置由它自己持久化到 `<部署>/config.json`，这边没有别的可信来源。读不到就保持原值 ——
   * 猜错模式会让用户要么听不到回答、要么听到两遍，两种都比不动更糟。
   */
  async refreshMode(): Promise<CorticoMode> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/api/config`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok)
        return this.mode
      const body = await response.json() as unknown
      const groups = (body as { groups?: unknown })?.groups
      if (!Array.isArray(groups))
        return this.mode
      for (const group of groups) {
        const values = (group as { values?: Record<string, unknown> })?.values
        if (values && typeof values.mode === 'string') {
          const next: CorticoMode = values.mode === 'work' ? 'work' : 'normal'
          if (next !== this.mode) {
            this.mode = next
            log.log(`mode changed to ${next}`)
            // 模式变化要推给渲染进程：切回普通模式意味着这边要开始读对方写下的记忆了，
            // 而这个轮询是唯一能发现「对方那边刚切过」的地方（Cortico 不会主动告诉我们）。
            this.setState(this.state)
          }
          return next
        }
      }
    }
    catch {
      // Cortico 没起来或还没就绪，保持上一次已知的模式
    }
    return this.mode
  }

  private startModePolling(): void {
    if (this.modeTimer)
      return
    void this.refreshMode()
    this.modeTimer = setInterval(() => void this.refreshMode(), MODE_POLL_MS)
  }

  private stopModePolling(): void {
    if (this.modeTimer) {
      clearInterval(this.modeTimer)
      this.modeTimer = null
    }
  }

  /** 诊断计数。见 `CorticoBridgeDiag` 的注释：用来定位断在哪一段。 */
  getDiag(): CorticoBridgeDiag {
    return {
      framesIn: this.framesIn,
      msgIn: this.msgIn,
      echoIn: this.echoIn,
      framesOut: this.framesOut,
      viewers: this.viewers,
    }
  }

  /** 由 register 层填入，因为只有它知道推给了几个窗口。 */
  setViewerCount(count: number): void {
    this.viewers = count
  }

  /** 由 register 层在每帧推送后调用。 */
  noteFramesOut(n: number): void {
    this.framesOut += n
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

    this.startModePolling()
    this.openSocket()
    return this.getState()
  }

  /** 主动断开，且不再自动重连。 */
  disconnect(): CorticoBridgeState {
    this.wanted = false
    this.clearReconnect()
    this.stopModePolling()
    this.closeSocket()
    this.setState({ state: 'disconnected', port: this.port, name: this.name })
    return this.getState()
  }

  /**
   * 发一条消息。未连接时返回失败而不是抛错，让调用方能显示提示。
   *
   * `silent` 打开时这条只进 Cortico 的事件库、不触发它回答：AIRI 自己已经在回这一轮，
   * 两边都答就成了「双答」。Cortico 侧对应 console World 的 `{type:'msg', silent:true}`，
   * 落到 `trigger: 'piggyback'`——不启动批次计时器，等下一次真有东西唤醒它时随那一批投递。
   */
  send(text: string, options: { silent?: boolean } = {}): { ok: true } | { ok: false, error: string } {
    const trimmed = text.trim()
    if (!trimmed)
      return { ok: false, error: '消息为空' }

    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return { ok: false, error: '尚未连接到 Cortico' }

    try {
      socket.send(JSON.stringify({ type: 'msg', text: trimmed, ...(options.silent ? { silent: true } : {}) }))
      this.rememberSent(trimmed)
      return { ok: true }
    }
    catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 记下刚发出去的正文，供 `handleFrame` 认回声。顺带清掉过期项，避免长跑时无界增长。 */
  private rememberSent(text: string): void {
    const now = Date.now()
    for (const [key, at] of this.sent) {
      if (now - at > ECHO_WINDOW_MS)
        this.sent.delete(key)
    }
    this.sent.set(text, now)
  }

  /** 判断一条入站消息是不是自己刚发出去那句被广播回来。命中即消费，同一句不会二次认领。 */
  private takeEcho(text: string): boolean {
    const at = this.sent.get(text)
    if (at === undefined)
      return false
    this.sent.delete(text)
    return Date.now() - at <= ECHO_WINDOW_MS
  }

  dispose(): void {
    this.disposed = true
    this.wanted = false
    this.clearReconnect()
    this.stopModePolling()
    this.closeSocket()
    this.sent.clear()
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
        ...(this.takeEcho(frame.text) ? { echo: true } : {}),
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
    this.framesIn++
    if (frame.kind === 'msg')
      this.msgIn++
    if (frame.echo)
      this.echoIn++
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
