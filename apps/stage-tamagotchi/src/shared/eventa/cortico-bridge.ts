import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/**
 * Cortico 桥接的 eventa 合约。
 *
 * 这些合约把主进程里那条长连接（WebSocket → Cortico 的 console World）暴露给渲染进程。
 * 渲染进程不自己连 Cortico，因为 AIRI 的渲染进程跑在 `file://` 下，Origin 是 `null`，
 * 而 Cortico 的 web server 在 upgrade 阶段会把 `Origin: null` 判成跨站并直接掐断 socket
 * （见 Cortico `src/web/server.ts:803`）。主进程用 Node 的 WebSocket，不发 Origin 头，
 * 因此不受这条同源闸门影响。
 */

/** Cortico console World 里的一帧，已归一化成渲染进程关心的字段。 */
export interface CorticoBridgeFrame {
  /** 消息正文 */
  text: string
  /** 发送者名字；`sys` 帧为 null */
  from: string | null
  /** 时间戳（毫秒） */
  ts: number
  /**
   * 帧种类。
   * - `msg`：对话消息（含 bot 的回复与历史回放）
   * - `sys`：系统提示（加入/离开/拒绝/告警）
   */
  kind: 'msg' | 'sys'
  /** `sys` 帧的子类，来自 Cortico 的 `kind` 字段 */
  sysKind?: 'rejected' | 'warning'
  /** 是否是加入时回放的历史消息 */
  history?: boolean
}

/** 桥接连接状态 */
export interface CorticoBridgeState {
  state: 'disconnected' | 'connecting' | 'online'
  /** Cortico WebUI 端口 */
  port: number
  /** 我们报给 Cortico 的名字 */
  name: string
  lastError?: string
}

/** 向 Cortico 发一条用户消息。 */
export const corticoBridgeSend = defineInvokeEventa<
  { ok: true } | { ok: false, error: string },
  { text: string }
>('eventa:invoke:airi:cortico-bridge:send')

/** 主动连接/重连。 */
export const corticoBridgeConnect = defineInvokeEventa<CorticoBridgeState, void>(
  'eventa:invoke:airi:cortico-bridge:connect',
)

/** 读当前状态。 */
export const corticoBridgeGetState = defineInvokeEventa<CorticoBridgeState, void>(
  'eventa:invoke:airi:cortico-bridge:state',
)

/** 断开。 */
export const corticoBridgeDisconnect = defineInvokeEventa<CorticoBridgeState, void>(
  'eventa:invoke:airi:cortico-bridge:disconnect',
)

/**
 * 订阅推送帧。调用一次后，该窗口开始收到 `corticoBridgeFrame` 与
 * `corticoBridgeStateChanged`。返回当前状态，便于订阅的同时拿到即时快照。
 */
export const corticoBridgeSubscribe = defineInvokeEventa<CorticoBridgeState, void>(
  'eventa:invoke:airi:cortico-bridge:subscribe',
)

/** 收到一帧（推送）。 */
export const corticoBridgeFrame = defineEventa<CorticoBridgeFrame>(
  'eventa:event:airi:cortico-bridge:frame',
)

/** 连接状态变化（推送）。 */
export const corticoBridgeStateChanged = defineEventa<CorticoBridgeState>(
  'eventa:event:airi:cortico-bridge:state-changed',
)
