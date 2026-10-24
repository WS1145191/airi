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
  /**
   * 这条是不是本桥接自己刚发出去、又被控制台广播回来的那一句。
   *
   * Cortico 的 console World 把消息广播给全部在线连接，包含发送者本身。转发用户消息时
   * 若不把回声认出来，界面会出现「用户说了一遍，角色又念了一遍同一句」。
   * 名字不能用来区分：bot 的 `from` 是 `cfg.displayName`（默认就是 `AIRI`），和本桥接报的
   * 名字撞车，所以由主进程按「最近发出去的文本 + 时间窗」判定。
   */
  echo?: boolean
}

/** 桥接连接状态 */
export interface CorticoBridgeState {
  state: 'disconnected' | 'connecting' | 'online'
  /** Cortico WebUI 端口 */
  port: number
  /** 我们报给 Cortico 的名字 */
  name: string
  /**
   * Cortico 当前的人格模式。
   *
   * `normal`：你问我答，AIRI 回答，Cortico 只记账（转发带 `silent`）
   * `work`：营业，Cortico 自己回答（转发不带 `silent`）
   *
   * 由主进程定期从 Cortico 的 `GET /api/config` 读取；读不到时保持上一次的值。
   */
  mode?: 'normal' | 'work'
  lastError?: string
}

/** 向 Cortico 发一条用户消息。 */
export const corticoBridgeSend = defineInvokeEventa<
  { ok: true } | { ok: false, error: string },
  {
    text: string
    /**
     * 这条是谁说的。
     *
     * - `user`：用户自己的话。普通模式下静默记账；营业模式下要唤醒 Cortico 由它来回答。
     * - `reply`：AIRI 自己刚说出口的回答。永远静默 —— 这句话已经在这儿说过了，
     *   再让 Cortico 回一遍就是双答。
     *
     * 省略按 `user` 处理。
     */
    origin?: 'user' | 'reply'
    /**
     * 强制静默：只入库、不唤醒 Cortico。
     *
     * 打开后这条消息仍然进 Cortico 的事件库（记忆完整），但不会触发它回答。
     * 不传则由主进程按当前模式和 `origin` 决定。
     */
    silent?: boolean
  }
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

/**
 * 诊断快照：桥接收到多少帧、推送给了几个窗口。
 *
 * 「Cortico 明明回了却看不见」可能断在四段里的任何一段：Cortico 没广播、主进程没读到、
 * 主进程没推给窗口、渲染层把帧过滤掉了。前两段看 `framesIn`，第三段看 `viewers`，
 * 剩下的靠渲染层自己的日志。没有这个数只能靠猜。
 */
export interface CorticoBridgeDiag {
  /** 主进程 socket 收到的帧总数 */
  framesIn: number
  /** 其中 msg 类帧数 */
  msgIn: number
  /** 被认作自己回声而标记的帧数 */
  echoIn: number
  /** 已推送出去的帧总数（× 窗口数） */
  framesOut: number
  /** 当前订阅着的窗口数 */
  viewers: number
}

/** 读诊断快照。 */
export const corticoBridgeDiag = defineInvokeEventa<CorticoBridgeDiag, void>(
  'eventa:invoke:airi:cortico-bridge:diag',
)
