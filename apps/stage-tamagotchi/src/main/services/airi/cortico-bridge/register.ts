import type { WebContents } from 'electron'

import type { CorticoBridge } from '.'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { ipcMain, webContents } from 'electron'

import {
  corticoBridgeConnect,
  corticoBridgeDiag,
  corticoBridgeDisconnect,
  corticoBridgeFrame,
  corticoBridgeGetState,
  corticoBridgeSend,
  corticoBridgeStateChanged,
  corticoBridgeSubscribe,
} from '../../../../shared/eventa/cortico-bridge'

/**
 * 把 Cortico 桥接接到渲染进程上。
 *
 * invoke 用一个不带 window 的 context：不管哪个窗口发起的调用都能到达同一个桥接实例
 * （与 `io-trace-hub/register.ts` 同样的理由 —— 带 window 的 context 会收到其它窗口的同名调用）。
 * 推送（收到的帧、状态变化）需要按窗口分发，所以订阅时给那个窗口单独建一个 context。
 */
export function registerCorticoBridge(bridge: CorticoBridge): () => void {
  const log = useLogg('cortico-bridge-register').useGlobalConfig()
  const { context, dispose } = createContext(ipcMain)

  interface Viewer {
    emitFrame: (payload: unknown) => void
    emitState: (payload: unknown) => void
    stop: () => void
  }

  const viewers = new Map<number, Viewer>()

  /**
   * Pushes are addressed to one sender instead of a `BrowserWindow`.
   *
   * `BrowserWindow.fromWebContents` answers null for a `WebContentsView`, and the main window hosts
   * its stage that way — a window-scoped context therefore reached nobody, and every frame Cortico
   * sent was dropped with no viewer to take it.
   *
   * The eventa adapter falls back to `raw.ipcMainEvent.sender` when it was built without a window,
   * so handing it the sender per emit reaches the same window without depending on its container.
   */
  function pushTo(sender: WebContents, event: unknown, payload: unknown): void {
    void context
      .emit(event as never, payload as never, { raw: { ipcMainEvent: { sender } } } as never)
      .then(() => log.log(`[diag] pushTo ok sender=${sender.id} destroyed=${sender.isDestroyed()}`))
      .catch((error: unknown) => log.withError(error).warn(`[diag] pushTo failed sender=${sender.id}`))
  }

  function stopViewer(id: number): void {
    viewers.get(id)?.stop()
    viewers.delete(id)
    bridge.setViewerCount(viewers.size)
  }

  function startViewer(sender: WebContents): void {
    stopViewer(sender.id)
    log.log(`[diag] startViewer sender=${sender.id} destroyed=${sender.isDestroyed()}`)

    const onDestroyed = () => stopViewer(sender.id)
    const stop = () => {
      sender.off('destroyed', onDestroyed)
    }
    sender.once('destroyed', onDestroyed)

    viewers.set(sender.id, {
      emitFrame: payload => pushTo(sender, corticoBridgeFrame, payload),
      emitState: payload => pushTo(sender, corticoBridgeStateChanged, payload),
      stop,
    })
    bridge.setViewerCount(viewers.size)
  }

  function broadcastFrame(payload: unknown): void {
    /**
     * 兜底：一个订阅者都没有时，向所有 webContents 广播。
     *
     * 渲染进程在启动早期就调用 subscribe，而那时这个 register 还没跑（cortico 服务要等进程探测完），
     * 于是那次 invoke 落在空处、也没有重试，viewers 就永远是 0。帧本身是广播语义，宁可多发几个
     * 窗口（没挂监听的窗口会直接忽略），也不能一条都发不出去。
     */
    const targets = viewers.size > 0
      ? [...viewers.values()].map(viewer => viewer.emitFrame)
      : webContents.getAllWebContents()
          .filter(sender => !sender.isDestroyed())
          .map(sender => (frame: unknown) => pushTo(sender, corticoBridgeFrame, frame))

    if (targets.length === 0) {
      log.warn(`[diag] frame dropped: no target ${JSON.stringify(payload).slice(0, 200)}`)
      return
    }
    for (const emitFrame of targets) {
      try {
        emitFrame(payload)
      }
      catch {}
    }
    bridge.noteFramesOut(targets.length)
    bridge.setViewerCount(targets.length)
  }

  function broadcastState(payload: unknown): void {
    const targets = viewers.size > 0
      ? [...viewers.values()].map(viewer => viewer.emitState)
      : webContents.getAllWebContents()
          .filter(sender => !sender.isDestroyed())
          .map(sender => (state: unknown) => pushTo(sender, corticoBridgeStateChanged, state))

    for (const emitState of targets) {
      try {
        emitState(payload)
      }
      catch {}
    }
  }

  const disposers = [
    defineInvokeHandler(context, corticoBridgeConnect, () => bridge.connect()),
    defineInvokeHandler(context, corticoBridgeDisconnect, () => bridge.disconnect()),
    defineInvokeHandler(context, corticoBridgeGetState, () => bridge.getState()),
    defineInvokeHandler(context, corticoBridgeSend, ({ text, silent, origin }) => bridge.send(text, {
      // AIRI 自己的回答永远只记账：这句话已经在这儿说过了，Cortico 再回一遍就是双答。
      // 用户的话在普通模式下也只记账（这边正在回答），营业模式下才唤醒 Cortico 由它来答。
      silent: silent ?? (origin === 'reply' || bridge.getMode() !== 'work'),
    })),
    defineInvokeHandler(context, corticoBridgeDiag, () => bridge.getDiag()),
    defineInvokeHandler(context, corticoBridgeSubscribe, (_, options) => {
      const sender = options?.raw?.ipcMainEvent?.sender
      log.log(`[diag] subscribe called, sender=${sender?.id ?? 'undefined'} optionsKeys=${Object.keys(options ?? {}).join(',')}`)
      if (sender)
        startViewer(sender)
      return bridge.getState()
    }),
  ]

  const stopFrame = bridge.onFrame(payload => broadcastFrame(payload))
  const stopState = bridge.onState(payload => broadcastState(payload))

  return () => {
    stopFrame()
    stopState()
    for (const viewer of viewers.values())
      viewer.stop()
    viewers.clear()
    for (const disposeHandler of disposers)
      disposeHandler()
    dispose()
  }
}
