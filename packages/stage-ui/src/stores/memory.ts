import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

/** One remembered fact. A character keeps it on its own card. A general memory reaches every card. */
export interface MemoryEntry {
  /** Short name in kebab case, unique within its scope. The index lists it, and tools address the entry by it. */
  name: string
  /** The index line: the fact itself when it fits in one line, or when the entry matters. */
  description: string
  body: string
  /** The character card that owns this memory. Without it, the owner made the memory general. */
  persona?: string
  /**
   * Set when the entry came from the other side (the persona that answers in work mode) rather than
   * being written here. It carries no card, so it reads as a general memory — which is right, both
   * sides share it — but forgetting it has to reach the file it came from, or the next import would
   * bring it back.
   */
  origin?: 'cortico'
  updatedAt: number
}

/**
 * Where a copy of the memories is also written.
 *
 * The store itself stays on this browser's localStorage: it is what every window reads
 * and writes, and what keeps the windows in agreement. This hook exists so the desktop
 * app can additionally mirror each change into files that another process can read —
 * the persona that answers in work mode lives in a different process and cannot see
 * this localStorage, so without the mirror the two would each keep half the story.
 *
 * The mirror writes one way on purpose: reading files back on every change would mean
 * merging two writers with no shared clock, and a half-merged memory is worse than a
 * memory that is merely incomplete. `pull` is the deliberate exception — called when
 * this side is about to answer, it fills in what the other side wrote in the meantime,
 * and never overwrites an entry already held here.
 *
 * A backend must never reject — a mirror that fails to write is not a failed
 * conversation, and losing a saved fact silently is better than aborting the turn.
 */
export interface MemoryBackend {
  /** Store one entry, replacing an entry of the same name and card. */
  save: (entry: MemoryEntry) => Promise<void> | void
  /** Remove one entry. */
  remove: (entry: Pick<MemoryEntry, 'name' | 'persona'>) => Promise<void> | void
  /**
   * Read what the other side has written, for the entries this store does not know about yet.
   *
   * Optional: a build with no second process has nothing to read. The store calls it on request and
   * merges the result, never replacing an entry it already holds — two writers with no shared clock
   * cannot be ordered, so a local entry always wins and an import only fills gaps.
   */
  pull?: () => Promise<ImportedMemory[]>
}

/** One entry read back from the other side. */
export interface ImportedMemory {
  name: string
  description: string
  body: string
}

let mirror: MemoryBackend | null = null

/**
 * Sets where changes are mirrored. Pass null to stop mirroring, such as in a browser
 * build that has no second process to share with.
 */
export function setMemoryBackend(next: MemoryBackend | null) {
  mirror = next
}

/** Turns a free name into the kebab-case key that entries use. */
export function memoryName(name: string) {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/**
 * Long-term memory as a small index and one entry per fact, kept by the character itself.
 *
 * Use when:
 * - A run reads the index or an entry, writes or forgets a fact, or Settings lists the memories by card.
 *
 * Expects:
 * - Callers pass the character card of the run. It reads its own memories and the general ones.
 * - Only the owner makes a memory general, in Settings. A run writes and forgets only its own card's memories.
 *
 * Returns:
 * - Whether memory is on, entries, the index for a card, and actions that change entries.
 */
export const useMemoryStore = defineStore('memory', () => {
  const enabled = useLocalStorageManualReset<boolean>('memory/enabled', true)
  const entries = useLocalStorageManualReset<MemoryEntry[]>('memory/entries', [])

  const sorted = computed(() => [...entries.value].sort((left, right) => left.name.localeCompare(right.name)))

  /** General memories and the persona's own. */
  function visibleTo(personaId: string) {
    return sorted.value.filter(entry => !entry.persona || entry.persona === personaId)
  }

  /** The index for a card: its own memories, then general ones, each as a name and its description. */
  function indexFor(personaId: string) {
    const line = (entry: MemoryEntry) => `- ${entry.name}: ${entry.description}`
    const byName = (left: MemoryEntry, right: MemoryEntry) => left.name.localeCompare(right.name)
    const own = sorted.value.filter(entry => entry.persona === personaId).sort(byName).map(line)
    const general = sorted.value.filter(entry => !entry.persona).sort(byName).map(line)
    return [
      ...(own.length ? [`Your own:\n${own.join('\n')}`] : []),
      ...(general.length ? [`General:\n${general.join('\n')}`] : []),
    ].join('\n')
  }

  /** Reads an entry by name. The persona's own entry wins over a general one with the same name. */
  function read(name: string, personaId: string) {
    const key = memoryName(name)
    const matches = visibleTo(personaId).filter(entry => entry.name === key)
    return matches.find(entry => entry.persona === personaId) ?? matches[0]
  }

  /** Creates or replaces an entry of the card by name. Returns the stored entry, or undefined for an empty name or body. */
  function write(entry: Pick<MemoryEntry, 'name' | 'description' | 'body'>, personaId: string) {
    const name = memoryName(entry.name)
    if (!name || !entry.body.trim())
      return undefined
    const next: MemoryEntry = { name, description: entry.description.trim(), body: entry.body.trim(), persona: personaId, updatedAt: Date.now() }
    entries.value = [...entries.value.filter(existing => existing.name !== name || existing.persona !== personaId), next]
    // The mirror only carries entries that belong to a card: a general one is the owner's,
    // and the other side has no owner to attribute it to.
    void mirror?.save(next)
    return next
  }

  /** Makes a card's memory general, so every card reads it. A general memory with the same name gives way. */
  function makeGeneral(entry: Pick<MemoryEntry, 'name' | 'persona'>) {
    const source = entries.value.find(existing => existing.name === entry.name && existing.persona === entry.persona)
    if (!source?.persona)
      return
    const { persona: _card, ...general } = source
    entries.value = [...entries.value.filter(existing => existing !== source && (existing.name !== source.name || existing.persona)), { ...general, updatedAt: Date.now() }]
  }

  /** Removes one entry, from a tool or from Settings. */
  function remove(entry: Pick<MemoryEntry, 'name' | 'persona'> & { origin?: 'cortico' }) {
    entries.value = entries.value.filter(existing => existing.name !== entry.name || existing.persona !== entry.persona)
    // An entry that came from the other side has no card to attribute it to, but the file is still
    // there: without this, the next import would read it back and the forget would undo itself.
    if (entry.persona || entry.origin === 'cortico')
      void mirror?.remove(entry)
  }

  /**
   * Reads what the other side wrote and adds the entries this store does not have.
   *
   * Called when the character comes back to this side — on startup, and when work mode hands the
   * conversation over. Without it the traffic is one way: a fact told to the persona in work mode sits
   * in a file that only that persona reads, and the character answering here would not know it, which
   * is the drift sharing a memory is supposed to prevent.
   *
   * Import only. A name this store already holds is left alone: the two sides keep their own copies
   * with no shared clock, so there is no order to merge them by, and a local entry is the one the user
   * just saw. Nothing is deleted either — a file gone from the other side is not evidence that the fact
   * became false.
   *
   * Returns how many were added, for the caller to report.
   */
  async function importFromOtherSide(): Promise<number> {
    if (!mirror?.pull)
      return 0
    let incoming: ImportedMemory[]
    try {
      incoming = await mirror.pull()
    }
    catch {
      // A memory that failed to read back is not a failed turn.
      return 0
    }
    if (!incoming.length)
      return 0

    // Name only: the files carry no card, so anything already known by that name — this card's own or
    // general — wins over what came back.
    const known = new Set(entries.value.map(entry => entry.name))
    const added: MemoryEntry[] = []
    for (const remote of incoming) {
      const name = memoryName(remote.name)
      if (!name || !remote.body.trim())
        continue
      if (known.has(name))
        continue
      known.add(name)
      added.push({
        name,
        description: remote.description.trim(),
        body: remote.body.trim(),
        origin: 'cortico',
        updatedAt: Date.now(),
      })
    }
    if (!added.length)
      return 0
    entries.value = [...entries.value, ...added]
    return added.length
  }

  /** Forgets an entry of the card by name. General memories belong to the owner, so a run cannot forget them. */
  function forget(name: string, personaId: string) {
    const key = memoryName(name)
    const target = entries.value.find(entry => entry.name === key && entry.persona === personaId)
    if (!target)
      return false
    remove(target)
    return true
  }

  function resetState() {
    enabled.reset()
    entries.reset()
  }

  return {
    enabled,
    entries: sorted,
    visibleTo,
    indexFor,
    read,
    write,
    makeGeneral,
    forget,
    remove,
    importFromOtherSide,
    resetState,
  }
})
