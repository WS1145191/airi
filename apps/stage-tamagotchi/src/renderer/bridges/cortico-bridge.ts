import type { EventContext } from '@moeru/eventa'

import { useLogg } from '@guiiai/logg'
import { defineInvoke } from '@moeru/eventa'
import { nanoid } from 'nanoid'

import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useCharacterStore } from '@proj-airi/stage-ui/stores/character'

import {
  corticoBridgeConnect,
  corticoBridgeDisconnect,
  corticoBridgeFrame,
  corticoBridgeGetState,
  corticoBridgeSend,
  corticoBridgeStateChanged,
  corticoBridgeSubscribe,
} from '../../shared/eventa/cortico-bridge'

const log = useLogg('electron:cortico-bridge').useGlobalConfig()

/** Same text arriving twice within this window is the console echoing a line we already took. */
const ECHO_WINDOW_MS = 5000

/**
 * Wires this window to the Cortico bridge that the main process holds.
 *
 * The main process owns the WebSocket: the console World runs on another origin, so a renderer socket
 * there is refused, and a window that closes would drop the connection. It also outlives the window.
 *
 * Each message Cortico sends becomes an assistant message in the chat history — so it lands in the
 * conversation the user is reading — and is then spoken through the character store, the same path a
 * model reply takes. Writing an assistant message directly is deliberate: Cortico already produced the
 * words, so there is no model turn to run here, and going through the model would answer the character's
 * own sentence.
 */
export function initializeCorticoBridge(context: EventContext<any, any>): () => void {
  const connect = defineInvoke(context, corticoBridgeConnect)
  const disconnect = defineInvoke(context, corticoBridgeDisconnect)
  const getState = defineInvoke(context, corticoBridgeGetState)
  const send = defineInvoke(context, corticoBridgeSend)
  const subscribe = defineInvoke(context, corticoBridgeSubscribe)

  const sessionStore = useChatSessionStore()
  const characterStore = useCharacterStore()

  /** Frames wait here so two of them cannot overtalk each other on the speech path. */
  const queue: string[] = []
  let draining = false
  let lastDelivered: { text: string, at: number } | null = null

  async function deliver(text: string) {
    const sessionId = sessionStore.activeSessionId

    try {
      sessionStore.appendSessionMessage(sessionId, {
        role: 'assistant',
        content: text,
        slices: [{ type: 'text', text }],
        tool_results: [],
        createdAt: Date.now(),
        completedAt: Date.now(),
        id: nanoid(),
        // Marks it as something the character said on its own rather than a reply to the user. Keeps
        // it out of cloud sync, which only carries replies to a send.
        proactive: { turnId: `cortico:${nanoid()}`, source: 'cortico' },
      })
    }
    catch (error) {
      log.withError(error).warn('Failed to append the Cortico message to the chat history')
    }

    try {
      await characterStore.emitTextOutput(text)
    }
    catch (error) {
      log.withError(error).warn('Failed to speak the Cortico message')
    }
  }

  async function drain() {
    if (draining)
      return
    draining = true
    try {
      while (queue.length > 0) {
        const next = queue.shift()!
        lastDelivered = { text: next, at: Date.now() }
        await deliver(next)
      }
    }
    finally {
      draining = false
    }
  }

  const stopFrameListener = context.on(corticoBridgeFrame, (event) => {
    const frame = event?.body
    if (!frame)
      return
    // System notices speak to whoever runs the console, not lines the character says.
    if (frame.kind !== 'msg')
      return
    // Replayed history is what was said before this window connected; showing it again would repeat
    // lines the user has already seen.
    if (frame.history)
      return

    const text = String(frame.text ?? '').trim()
    if (!text)
      return
    if (lastDelivered && lastDelivered.text === text && Date.now() - lastDelivered.at < ECHO_WINDOW_MS)
      return

    queue.push(text)
    void drain()
  })

  const stopStateListener = context.on(corticoBridgeStateChanged, (event) => {
    const state = event?.body
    if (state)
      log.log(`Cortico bridge: ${state.state}${state.lastError ? ` (${state.lastError})` : ''}`)
  })

  void subscribe().catch(error => log.withError(error).warn('Failed to subscribe to the Cortico bridge'))

  return () => {
    stopFrameListener()
    stopStateListener()
    queue.length = 0
    void disconnect().catch(() => {})
    // Reachable from a settings panel or a command later; keeping them referenced here means the
    // invoke layer is already constructed when that lands.
    void connect
    void getState
    void send
  }
}
