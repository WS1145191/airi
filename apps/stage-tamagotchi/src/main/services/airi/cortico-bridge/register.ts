import type { WebContents } from 'electron'

import type { CorticoBridge } from '.'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { BrowserWindow, ipcMain } from 'electron'

import {
  corticoBridgeConnect,
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
  const { context, dispose } = createContext(ipcMain)

  interface Viewer {
    emitFrame: (payload: unknown) => void
    emitState: (payload: unknown) => void
    stop: () => void
  }

  const viewers = new Map<number, Viewer>()

  function stopViewer(id: number): void {
    viewers.get(id)?.stop()
    viewers.delete(id)
  }

  function startViewer(sender: WebContents): void {
    stopViewer(sender.id)

    const window = BrowserWindow.fromWebContents(sender)
    if (!window)
      return

    const viewer = createContext(ipcMain, window)
    const onDestroyed = () => stopViewer(sender.id)
    const stop = () => {
      viewer.dispose()
      sender.off('destroyed', onDestroyed)
    }
    sender.once('destroyed', onDestroyed)

    viewers.set(sender.id, {
      emitFrame: payload => void viewer.context.emit(corticoBridgeFrame as never, payload as never),
      emitState: payload => void viewer.context.emit(corticoBridgeStateChanged as never, payload as never),
      stop,
    })
  }

  function broadcastFrame(payload: unknown): void {
    for (const viewer of viewers.values()) {
      try {
        viewer.emitFrame(payload)
      }
      catch {}
    }
  }

  function broadcastState(payload: unknown): void {
    for (const viewer of viewers.values()) {
      try {
        viewer.emitState(payload)
      }
      catch {}
    }
  }

  const disposers = [
    defineInvokeHandler(context, corticoBridgeConnect, () => bridge.connect()),
    defineInvokeHandler(context, corticoBridgeDisconnect, () => bridge.disconnect()),
    defineInvokeHandler(context, corticoBridgeGetState, () => bridge.getState()),
    defineInvokeHandler(context, corticoBridgeSend, ({ text }) => bridge.send(text)),
    defineInvokeHandler(context, corticoBridgeSubscribe, (_, options) => {
      const sender = options?.raw.ipcMainEvent.sender
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
