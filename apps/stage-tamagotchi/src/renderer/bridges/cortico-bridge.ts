import type { EventContext } from '@moeru/eventa'
import type { MemoryBackend } from '@proj-airi/stage-ui/stores/memory'

import { useLogg } from '@guiiai/logg'
import { defineInvoke } from '@moeru/eventa'
import { nanoid } from 'nanoid'

import { getChatHistoryItemCopyText } from '@proj-airi/stage-ui/components/scenarios/chat/utils'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useCharacterStore } from '@proj-airi/stage-ui/stores/character'
import { setMemoryBackend, useMemoryStore } from '@proj-airi/stage-ui/stores/memory'

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
import { listCorticoMemory, removeCorticoMemory, writeCorticoMemory } from '../services/cortico-memory'

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
 * `pull` is the other direction, and the reason the mirror is worth having: a fact told to the persona
 * in work mode lands in a file, and the character answering here reads it back on the way in. The merge
 * rule lives in the store (import fills gaps, a local entry wins); this side only supplies the files.
 *
 * Every failure is swallowed: a memory that failed to mirror is not a failed conversation.
 */
function memoryBackendForCortico(): MemoryBackend {
  return {
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
    pull: async () => {
      const entries = await listCorticoMemory()
      return entries.map(entry => ({ name: entry.name, description: entry.description, body: entry.body }))
    },
  }
}

/**
 * Points the memory store at the Cortico workspace, in whichever window calls this.
 *
 * Every window needs its own call: `setMemoryBackend` writes a module-level variable, and each window
 * is a separate JavaScript context with its own copy of that module. Settings is the window that
 * matters most here — forgetting an entry there has to reach the file, or the file outlives the forget
 * and the next import reads the fact straight back in. Only the leader window also runs the bridge
 * (one socket, one send hook); this part is per window and independent of that.
 */
export function installCorticoMemoryBackend(): () => void {
  setMemoryBackend(memoryBackendForCortico())
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
  /** Last mode seen, so a repeated state push does not read the memory directory again. */
  let lastMode: string | null = null

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

    // 回到普通模式 = 这边要重新开始答话，此刻把对方在这段时间里写下的记忆读回来。
    const mode = state?.mode
    if (mode && mode !== lastMode) {
      lastMode = mode
      if (mode === 'normal')
        void pullMemory('mode switched to normal')
    }
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
      // Read the other side's memories before this turn composes its context, so a fact told to the
      // persona in work mode is already here when the character answers now. Awaited on purpose: the
      // whole point is that it lands before the reply, and the read is one directory listing.
      await pullMemory('before send')
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

  const memoryStore = useMemoryStore()

  /**
   * 把对方写下的记忆读回来。
   *
   * 触发点只有两个，都是「这边要开始说话」的时刻：进程刚起来（上一次可能是在营业模式里结束的），
   * 以及模式从 work 回到 normal。不轮询文件：文件变了不等于这边正在答话，而每次答话前扫一遍
   * 已经足够 —— 晚一轮知道，比每 15 秒读一次盘便宜得多。
   */
  async function pullMemory(trigger: string) {
    try {
      const added = await memoryStore.importFromOtherSide()
      if (added > 0)
        log.log(`Imported ${added} memory entr${added === 1 ? 'y' : 'ies'} from Cortico (${trigger})`)
    }
    catch (error) {
      log.withError(error).warn('Failed to read the Cortico memories back')
    }
  }

  void pullMemory('startup')

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
    clearInterval(diagTimer)
    queue.length = 0
    void disconnect().catch(() => {})
    // Reachable from a settings panel or a command later; keeping them referenced here means the
    // invoke layer is already constructed when that lands.
    void connect
    void getState
  }
}
