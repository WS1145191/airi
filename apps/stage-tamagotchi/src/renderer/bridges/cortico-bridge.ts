import type { EventContext } from '@moeru/eventa'

import { useLogg } from '@guiiai/logg'
import { defineInvoke } from '@moeru/eventa'
import { nanoid } from 'nanoid'

import { getChatHistoryItemCopyText } from '@proj-airi/stage-ui/components/scenarios/chat/utils'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useCharacterStore } from '@proj-airi/stage-ui/stores/character'
import { setMemoryBackend } from '@proj-airi/stage-ui/stores/memory'

import {
  corticoBridgeConnect,
  corticoBridgeDiag,
  corticoBridgeDisconnect,
  corticoBridgeFrame,
  corticoBridgeGetState,
  corticoBridgeSend,
  corticoBridgeStateChanged,
  corticoBridgeSubscribe,
} from '../../shared/eventa/cortico-bridge'
import { removeCorticoMemory, writeCorticoMemory } from '../services/cortico-memory'

const log = useLogg('electron:cortico-bridge').useGlobalConfig()

/** Same text arriving twice within this window is the console echoing a line we already took. */
const ECHO_WINDOW_MS = 5000

/**
 * Strips the performance directives the character model writes into its own text.
 *
 * AIRI's reply carries `<|ACT {"emotion":"neutral"}|><|DELAY 1|>` markers that drive the avatar; they
 * are instructions for the stage, not words. Cortico stores what it is given verbatim, so without this
 * its log fills with markers that mean nothing on that side and read as noise in work mode.
 */
function stripPerformanceDirectives(text: string): string {
  return text
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * Mirrors the character's long-term memory into Cortico's workspace.
 *
 * The store keeps its own copy in this browser's localStorage, which every window reads and
 * writes. That copy is invisible to Cortico: it runs in another process and its memory is the
 * files under `deployments/<name>/workspace/`. Without the mirror, a fact learned in normal mode
 * would simply not exist for the persona that answers in work mode — the two would drift into
 * separate characters sharing one face.
 *
 * The direction is deliberate. Two writers over the same files with no shared clock would need a
 * merge, and a half-merged memory is worse than one that is merely incomplete, so the store stays
 * authoritative here and the files are the other side's view. `write` runs on every save, so the
 * files catch up within one turn rather than at some later sync point.
 *
 * Every failure is swallowed: a memory that failed to mirror is not a failed conversation.
 */
function mirrorMemoryToCortico(): () => void {
  setMemoryBackend({
    save: (entry) => {
      void writeCorticoMemory({
        name: entry.name,
        description: entry.description,
        body: entry.body,
      }).catch(error => log.withError(error).warn('Failed to mirror a memory entry into Cortico'))
    },
    remove: (entry) => {
      void removeCorticoMemory(entry.name).catch(error => log.withError(error).warn('Failed to remove a mirrored memory entry'))
    },
  })
  return () => setMemoryBackend(null)
}

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
  const chatStore = useChatStore()

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
    log.log(`[diag] frame arrived: ${JSON.stringify(frame)}`)
    if (!frame)
      return
    // System notices speak to whoever runs the console, not lines the character says.
    if (frame.kind !== 'msg')
      return
    // Replayed history is what was said before this window connected; showing it again would repeat
    // lines the user has already seen.
    if (frame.history)
      return
    // The console broadcasts to every connection, sender included. Our own forwarded line comes back
    // here; the user already said it, and repeating it would make the character echo the user.
    if (frame.echo)
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

  /**
   * Forwards what the user says to Cortico, so its persona answers with the whole World set behind it
   * instead of only the AIRI tool channel.
   *
   * The hook is `onBeforeSend` rather than the send action itself: by then the user message is already
   * stored and the text still reads as the user's own, whereas `composedMessage` has the system prompt
   * and the context blocks rolled into it and would hand Cortico a page of instructions.
   *
   * A hook that throws aborts the send, so every failure here is logged and swallowed — the character
   * still has to answer in AIRI's own conversation even when the console is down.
   *
   * In `normal` mode the line goes in `silent`: this side is the one answering, and Cortico answering
   * too is exactly the double reply. Silencing keeps the line in its event log for memory without
   * waking it — `piggyback` on the Cortico side does not start a batch timer, so the turn reaches it
   * together with whatever wakes it next. In `work` mode Cortico is the one who should speak, so the
   * line is forwarded normally and AIRI's own reply is not sent back at all.
   */
  const stopForwardHook = chatStore.onBeforeSend(async (_composed, hookContext) => {
    try {
      const text = getChatHistoryItemCopyText(hookContext.message).trim()
      if (!text)
        return
      const result = await send({ text, origin: 'user' })
      if (!result.ok)
        log.log(`Not forwarded to Cortico: ${result.error}`)
    }
    catch (error) {
      log.withError(error).warn('Failed to forward the user message to Cortico')
    }
  })

  /**
   * Hands AIRI's own answer back to Cortico.
   *
   * Without this, Cortico's log holds only half the conversation — every question the user asked and
   * none of the answers. When work mode wakes it up it would read a monologue of questions. Sent
   * `silent` for the same reason as the user line: the words were already said out loud here, and a
   * second reply would be the double answer again.
   *
   * `onChatTurnComplete` rather than `onAssistantResponseEnd`: the latter fires per response segment and
   * would split one answer into several log lines; the former carries the whole turn's `outputText`.
   */
  const stopReplyHook = chatStore.onChatTurnComplete(async (chat) => {
    try {
      const text = stripPerformanceDirectives(String(chat.outputText ?? '')).trim()
      if (!text)
        return
      const result = await send({ text, origin: 'reply' })
      if (!result.ok)
        log.log(`AIRI reply not stored in Cortico: ${result.error}`)
    }
    catch (error) {
      log.withError(error).warn('Failed to send the AIRI reply to Cortico')
    }
  })

  const diag = defineInvoke(context, corticoBridgeDiag)

  // 记忆镜像只在 leader 窗口装：每个窗口各装一份会重复写同一个文件。
  const stopMemoryMirror = mirrorMemoryToCortico()

  void subscribe().catch(error => log.withError(error).warn('Failed to subscribe to the Cortico bridge'))

  // 每秒报一次诊断，只在控制台里看得到；用来定位「Cortico 说了但界面没收」断在哪一段。
  const diagTimer = setInterval(() => {
    void diag().then((d) => {
      log.log(`[diag] in=${d.framesIn} msg=${d.msgIn} echo=${d.echoIn} out=${d.framesOut} viewers=${d.viewers}`)
    }).catch(() => {})
  }, 5000)

  return () => {
    stopFrameListener()
    stopStateListener()
    stopForwardHook()
    stopReplyHook()
    stopMemoryMirror()
    clearInterval(diagTimer)
    queue.length = 0
    void disconnect().catch(() => {})
    // Reachable from a settings panel or a command later; keeping them referenced here means the
    // invoke layer is already constructed when that lands.
    void connect
    void getState
  }
}
