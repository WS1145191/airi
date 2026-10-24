<script setup lang="ts">
import type { MemoryEntry } from '@proj-airi/stage-ui/stores/memory'

import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { computed, onMounted, ref } from 'vue'

import { getCorticoMemoryStatus, listCorticoMemory } from '../../../services/cortico-memory'

/**
 * 长期记忆设置页
 *
 * 路径不叫 `memory`：`packages/stage-pages` 里已经有一个 `settings/memory` 占位页（WIP），
 * 两个文件路由撞同一路径时谁胜出取决于扫描顺序，占位页会把这一页顶掉。
 *
 * 这张页要回答三个问题：记住了什么、记在哪儿、另一个人格看不看得到。
 *
 * 记忆本身由 `useMemoryStore` 持有（localStorage，各窗口共享）。每次写/删都会镜像一份到
 * Cortico 的部署目录（`deployments/<名>/workspace/memory/*.md`），所以营业模式的 persona
 * 读到的是同一批事实。页面上显示的目录就是镜像落点，可以自己去文件管理器里查看。
 */

const memoryStore = useMemoryStore()
const cardStore = useAiriCardStore()

interface MirroredFile {
  name: string
  description: string
  updatedAt: number
}

const mirror = ref<MirroredFile[]>([])
const directory = ref('')
const mirrorError = ref('')
const mirrorExists = ref(false)
const loading = ref(false)
const removing = ref<string | null>(null)
const showGeneral = ref(true)

/** 卡片 id → 名字，条目上只有 id */
const cardNames = computed(() => {
  const names = new Map<string, string>()
  for (const [id, card] of cardStore.cards)
    names.set(id, card.name || id)
  return names
})

const entries = computed<MemoryEntry[]>(() => memoryStore.entries as MemoryEntry[])

const visibleEntries = computed(() => {
  // 营业模式带回来的条目也算「角色自己的」：同一个角色写的，只是那段时间由另一侧落笔。
  const owned = (entry: MemoryEntry) => !!entry.persona || entry.origin === 'cortico'
  const list = showGeneral.value ? entries.value : entries.value.filter(owned)
  return [...list].sort((left, right) => {
    // 属于某张卡片的排前面：主人更常找的是角色自己的记忆。
    if (owned(left) !== owned(right))
      return owned(left) ? -1 : 1
    return left.name.localeCompare(right.name)
  })
})

const mirroredNames = computed(() => new Set(mirror.value.map(file => file.name)))

function ownerOf(entry: MemoryEntry): string {
  // 营业模式那边写下的条目没有卡片归属（Cortico 不知道 AIRI 的卡），但它不是「通用」——
  // 「通用」是主人主动放开的，这个只是还没有人来认领。
  if (entry.origin === 'cortico')
    return '营业模式'
  if (!entry.persona)
    return '通用'
  return cardNames.value.get(entry.persona) ?? entry.persona
}

function formatTime(ts: number): string {
  if (!ts)
    return ''
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function refreshMirror() {
  loading.value = true
  try {
    const status = await getCorticoMemoryStatus()
    directory.value = status.directory
    mirrorExists.value = status.exists
    mirrorError.value = status.error ?? ''
    const files = await listCorticoMemory()
    mirror.value = files.map(file => ({
      name: file.name,
      description: file.description,
      updatedAt: file.updatedAt,
    }))
  }
  finally {
    loading.value = false
  }
}

async function forget(entry: MemoryEntry) {
  if (removing.value)
    return
  removing.value = entry.name
  try {
    // `origin` has to travel: an entry that came back from the other side has no card, and without
    // it the forget would only drop the copy here while the file stayed — the next import would read
    // the fact straight back in.
    memoryStore.remove({ name: entry.name, persona: entry.persona, origin: entry.origin })
    // 镜像写入是异步的，等一拍再读，否则会看到删之前的目录。
    await new Promise(resolve => setTimeout(resolve, 150))
    await refreshMirror()
  }
  finally {
    removing.value = null
  }
}

async function makeGeneral(entry: MemoryEntry) {
  memoryStore.makeGeneral({ name: entry.name, persona: entry.persona })
}

onMounted(() => {
  void refreshMirror()
})
</script>

<template>
  <div flex="~ col gap-4" font-normal>
    <!-- 说明与落点 -->
    <section rounded-xl border="~ neutral-300/50 dark:neutral-700/50" bg="neutral-100/40 dark:neutral-900/30" p-4>
      <h2 text-sm font-semibold>
        长期记忆
      </h2>
      <p mt-1 text-xs text-neutral-500 dark:text-neutral-400>
        角色自己记下的事实。普通模式由 AIRI 写，营业模式由 Cortico 写，两边指向同一批文件。
      </p>
      <div mt-3 flex="~ col gap-1" text-xs>
        <div text-neutral-500 dark:text-neutral-400>
          镜像目录
        </div>
        <div break-all font-mono text-neutral-700 dark:text-neutral-300>
          {{ directory || '（Cortico 尚未启动，目录还不知道）' }}
        </div>
        <div v-if="mirrorError" mt-1 text-amber-600 dark:text-amber-400>
          {{ mirrorError }}
        </div>
        <div v-else mt-1 flex="~ row items-center gap-2" text-neutral-500>
          <span>{{ loading ? '正在读取…' : `${mirror.length} 个文件` }}</span>
          <span v-if="!mirrorExists" text="amber-600 dark:amber-400">（目录还没建，第一次写入时创建）</span>
        </div>
      </div>
      <div mt-3 flex="~ row items-center gap-2">
        <button
          type="button" rounded-lg bg="neutral-200/70 dark:neutral-700/50" px-3 py-1.5 text-xs
          hover:bg="neutral-300/70 dark:neutral-600/50" :disabled="loading" @click="refreshMirror"
        >
          刷新
        </button>
        <label flex="~ row items-center gap-1.5" text-xs text-neutral-500>
          <input v-model="showGeneral" type="checkbox">
          显示通用记忆
        </label>
      </div>
    </section>

    <!-- 条目列表 -->
    <section rounded-xl border="~ neutral-300/50 dark:neutral-700/50" p-4>
      <div flex="~ row items-center justify-between gap-2">
        <h2 text-sm font-semibold>
          已记住的事实
        </h2>
        <span rounded-full bg="neutral-200/60 dark:neutral-800" px-2 py-0.5 text-xs text-neutral-600 dark:text-neutral-300>
          {{ visibleEntries.length }}
        </span>
      </div>

      <div
        v-if="!visibleEntries.length"
        mt-3 border-2 rounded-lg border-dashed border-neutral-200 p-6 text-center text-xs text-neutral-500 dark:border-neutral-800
      >
        还没有记忆。跟它聊足够久，它自己会决定记住什么。
      </div>

      <ul v-else mt-3 flex="~ col gap-2">
        <li
          v-for="entry in visibleEntries"
          :key="`${entry.persona ?? 'general'}:${entry.name}`"
          rounded-lg border="~ neutral-300/40 dark:neutral-700/40" bg="neutral-100/30 dark:neutral-900/20" p-3
        >
          <div flex="~ row items-start justify-between gap-3">
            <div min-w-0 flex-1>
              <div flex="~ row flex-wrap items-center gap-2">
                <span text-sm font-medium break-all>{{ entry.name }}</span>
                <span rounded px-1.5 py-0.5 text="[10px] neutral-600 dark:neutral-300" bg="neutral-200/70 dark:neutral-800">
                  {{ ownerOf(entry) }}
                </span>
                <span
                  v-if="(entry.persona || entry.origin === 'cortico') && mirroredNames.has(entry.name)"
                  rounded px-1.5 py-0.5 text="[10px] emerald-700 dark:emerald-300" bg="emerald-500/15"
                >
                  已同步
                </span>
              </div>
              <p mt-1 text-xs text-neutral-600 dark:text-neutral-400>
                {{ entry.description || '（无描述）' }}
              </p>
              <p v-if="entry.body && entry.body !== entry.description" mt-1 line-clamp-3 text-xs text-neutral-500 dark:text-neutral-500>
                {{ entry.body }}
              </p>
              <div mt-1 text="[10px] neutral-400">
                更新于 {{ formatTime(entry.updatedAt) }}
              </div>
            </div>
            <div flex="~ col gap-1">
              <button
                v-if="entry.persona"
                type="button" rounded px-2 py-1 text="[11px] neutral-600 dark:neutral-300"
                bg="neutral-200/60 dark:neutral-800/60" hover:bg="neutral-300/60 dark:neutral-700/60"
                @click="makeGeneral(entry)"
              >
                设为通用
              </button>
              <button
                type="button" rounded px-2 py-1 text="[11px] red-600 dark:red-300"
                bg="red-500/10" hover:bg="red-500/20"
                :disabled="removing !== null" @click="forget(entry)"
              >
                {{ removing === entry.name ? '…' : '忘掉' }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: 长期记忆
  subtitle: 它记住了什么，记在哪儿
  description: 普通模式与营业模式共用的记忆库
  icon: i-solar:notebook-bold-duotone
  settingsEntry: true
  order: 11
  stageTransition:
    name: slide
</route>
