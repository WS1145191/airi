<script setup lang="ts">
import type { CorticoDeployment } from '../../../../shared/eventa/cortico-bridge'
import type { ElectronCorticoStatus } from '../../../../shared/eventa'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { electronEnsureCorticoStarted, electronGetCorticoStatus } from '../../../../shared/eventa'
import { listCorticoDeployments, switchCorticoDeployment } from '../../../services/cortico-memory'

/**
 * Cortico 设置页
 *
 * Cortico 以独立进程运行（`node bin/cortico.mjs <部署名>`，WebUI 默认 127.0.0.1:7788）。
 * 本页做三件事：
 *   1. 用 iframe 裱它官方的 WebUI（完整配置能力都在里面）
 *   2. 提供快捷控制：模式切换（normal/work）、运行暂停/恢复、世界开关
 *   3. 显示实时状态（模型、活跃世界、消息数、缓存命中）
 *
 * 跨域：Cortico 不发 CORS 头，主进程 side 的 `cortico-cors.ts`
 * 已在 onHeadersReceived 上给本机 7788 端口补了 CORS 响应头。
 */

const STORAGE_KEY = 'settings/cortico/base-url'
const DEFAULT_BASE_URL = 'http://127.0.0.1:7788'
/** 设置页里的「模式」字段，由 Cortico 的 cormini persona 提供（见 modeConfigGroup） */
const MODE_GROUP = 'cormini:mode'

interface CorticoStatus {
  displayName?: string
  modelConnection?: {
    name?: string
    model?: string
    module?: string
    baseUrl?: string
    ready?: boolean
  }
  startedAt?: string
  loop?: {
    running?: boolean
    paused?: boolean
    messageCount?: number
    estTokens?: number
    batchesHandled?: number
    lastUsage?: { promptTokens?: number, completionTokens?: number, cacheHitTokens?: number, cacheMissTokens?: number }
  }
  context?: { maxTokens?: number, softRatio?: number }
  uptimeSec?: number
  onboardingPending?: boolean
}

interface CorticoWorld {
  id: string
  label?: string
  name?: string
  /** Cortico 用 status 表示：active / inactive */
  status?: string
  declared?: boolean
  visible?: boolean
}

interface ConfigGroupEntry {
  group: { id: string, owner?: string, schema?: { title?: string, properties?: Record<string, any> } }
  values: Record<string, unknown>
}

interface ConfigOption {
  value?: string
  label?: string
  description?: string
}

/** enum 的中文展示名（options 接口目前返回空数组，只能自己映射） */
const MODE_LABELS: Record<string, string> = {
  normal: '普通（一问一答）',
  work: '营业（自主发起）',
}

const baseUrl = ref(DEFAULT_BASE_URL)
const draft = ref(DEFAULT_BASE_URL)
const online = ref<boolean | null>(null)
const busy = ref<string | null>(null)
const errorText = ref('')
const frameKey = ref(0)

const status = ref<CorticoStatus | null>(null)
const worlds = ref<CorticoWorld[]>([])
const modeOptions = ref<ConfigOption[]>([])
const currentMode = ref<string>('')
const tickMinutes = ref<number | null>(null)

/** 主进程侧的托管状态（Cortico 是不是 AIRI 拉起来的） */
const host = ref<ElectronCorticoStatus | null>(null)
const getHostStatus = useElectronEventaInvoke(electronGetCorticoStatus)
const ensureStarted = useElectronEventaInvoke(electronEnsureCorticoStarted)

/**
 * 可切换的部署（= bot）。
 *
 * 一个进程只跑一个 bot（`deployment.json` 的 `bot` 字段在启动时定死），所以「切 bot」
 * 实际是「换一份部署重启进程」。下拉框列部署而不是 bot 代码包：同一个 bot 可以有多份
 * 部署（不同端口），只列包名会分不清点的是哪一份。
 */
const deployments = ref<CorticoDeployment[]>([])
const selectedDeployment = ref<string>('')

let pollTimer: ReturnType<typeof setInterval> | undefined

const displayBase = computed(() => baseUrl.value.replace(/\/+$/, ''))
const frameSrc = computed(() => `${displayBase.value}/`)
const isPaused = computed(() => status.value?.loop?.paused === true || status.value?.loop?.running === false)
const uptimeText = computed(() => {
  const sec = status.value?.uptimeSec
  if (typeof sec !== 'number')
    return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
})
const usageText = computed(() => {
  const u = status.value?.loop?.lastUsage
  if (!u)
    return ''
  const hit = u.cacheHitTokens ?? 0
  const miss = u.cacheMissTokens ?? 0
  const total = hit + miss
  const pct = total > 0 ? Math.round((hit / total) * 100) : 0
  return `缓存 ${pct}% · ${u.promptTokens ?? 0}/${u.completionTokens ?? 0} tok`
})

function normalize(value: string): string {
  const trimmed = value.trim()
  if (!trimmed)
    return DEFAULT_BASE_URL
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

function persist(value: string) {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  }
  catch {}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${displayBase.value}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  })
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`)
  const text = await response.text()
  return text ? JSON.parse(text) as T : ({} as T)
}

async function refreshStatus() {
  try {
    status.value = await api<CorticoStatus>('/api/status')
    online.value = true
    errorText.value = ''
  }
  catch (error) {
    online.value = false
    status.value = null
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

async function refreshWorlds() {
  try {
    const raw = await api<{ worlds?: CorticoWorld[] } | CorticoWorld[]>('/api/worlds')
    worlds.value = Array.isArray(raw) ? raw : (raw.worlds ?? [])
  }
  catch {
    worlds.value = []
  }
}

function worldEnabled(world: CorticoWorld): boolean {
  return world.status === 'active'
}

async function refreshMode() {
  try {
    const payload = await api<{ groups?: ConfigGroupEntry[] }>('/api/config')
    const entry = payload.groups?.find(g => g.group?.id === MODE_GROUP)
    const values = entry?.values ?? {}
    const mode = values.mode
    if (typeof mode === 'string')
      currentMode.value = mode
    const minutes = values['tick.intervalMinutes']
    tickMinutes.value = typeof minutes === 'number' ? minutes : null

    // 优先用 schema 里的 enum 自举选项，title/description 也取自 schema
    const props = entry?.group?.schema?.properties ?? {}
    const modeProp = props.mode as { enum?: string[], title?: string, description?: string } | undefined
    if (Array.isArray(modeProp?.enum) && modeProp.enum.length > 0) {
      modeOptions.value = modeProp.enum.map(value => ({
        value,
        label: MODE_LABELS[value] ?? value,
        description: modeProp.description,
      }))
    }
    else {
      modeOptions.value = [
        { value: 'normal', label: MODE_LABELS.normal },
        { value: 'work', label: MODE_LABELS.work },
      ]
    }
  }
  catch {
    if (modeOptions.value.length === 0) {
      modeOptions.value = [
        { value: 'normal', label: MODE_LABELS.normal },
        { value: 'work', label: MODE_LABELS.work },
      ]
    }
  }
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshWorlds(), refreshMode()])
  await refreshHost()
  await refreshDeployments()
}

/**
 * 读可切换的部署列表，并把当前跑着的那份设为选中。
 *
 * 跟着主进程的真实部署名走，而不是记在 localStorage 里：用户可能直接敲命令行换了部署，
 * 这边记的旧值会指到一个没在跑的东西上。
 */
async function refreshDeployments() {
  try {
    deployments.value = await listCorticoDeployments()
    const current = host.value?.deployment
    if (current)
      selectedDeployment.value = current
    else if (!selectedDeployment.value && deployments.value.length > 0)
      selectedDeployment.value = deployments.value.find(item => item.active)?.name ?? ''
  }
  catch {
    deployments.value = []
  }
}

/** 切到另一份部署：停当前进程、用新部署起进程、桥接改连新端口。 */
async function applyDeployment() {
  const name = selectedDeployment.value
  if (busy.value || !name)
    return
  if (deployments.value.find(item => item.name === name)?.active && online.value)
    return

  busy.value = `deploy:${name}`
  errorText.value = ''
  try {
    const result = await switchCorticoDeployment(name)
    if (!result.ok) {
      errorText.value = `切换失败：${result.error}`
      return
    }
    // 端口跟着部署走（7788 / 7789 / 7790），地址栏与 iframe 一起换，否则还裱着上一个人的页面。
    const next = `http://127.0.0.1:${result.deployment.port}`
    baseUrl.value = next
    draft.value = next
    localStorage.setItem(STORAGE_KEY, next)
    frameKey.value += 1
    await refreshAll()
  }
  catch (error) {
    errorText.value = `切换失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = null
  }
}

/** 读主进程的托管状态；IPC 不可用时（比如在浏览器里跑）静默跳过 */
async function refreshHost() {
  try {
    host.value = await getHostStatus()
  }
  catch {
    host.value = null
  }
}

/** 请主进程把 Cortico 拉起来（已在跑则复用） */
async function startHosted() {
  if (busy.value)
    return
  busy.value = 'host:start'
  errorText.value = ''
  try {
    host.value = await ensureStarted()
    frameKey.value += 1
    await refreshAll()
  }
  catch (error) {
    errorText.value = `启动 Cortico 失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = null
  }
}

/** 托管状态的一句话描述 */
const hostLabel = computed(() => {
  const h = host.value
  if (!h)
    return ''
  switch (h.state) {
    case 'online':
      return h.managed ? `由 AIRI 托管（pid ${h.pid ?? '?'}）` : '外部实例'
    case 'external':
      return '外部实例（AIRI 不会关它）'
    case 'starting':
      return '正在启动…'
    case 'unavailable':
      return '未找到 Cortico 仓库'
    case 'error':
      return `启动失败${h.lastError ? `：${h.lastError}` : ''}`
    case 'stopped':
      return '已停止'
    default:
      return ''
  }
})

const canStartHosted = computed(() => {
  if (online.value)
    return false
  const h = host.value
  return !h || h.state === 'stopped' || h.state === 'error' || h.state === 'unavailable'
})

async function switchMode(mode: string) {
  if (busy.value || mode === currentMode.value)
    return
  busy.value = `mode:${mode}`
  errorText.value = ''
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ group: MODE_GROUP, values: { mode } }),
    })
    currentMode.value = mode
    await refreshStatus()
  }
  catch (error) {
    errorText.value = `切换模式失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = null
  }
}

async function toggleRun() {
  if (busy.value)
    return
  const action = isPaused.value ? 'resume' : 'pause'
  busy.value = `run:${action}`
  errorText.value = ''
  try {
    await api(`/api/run/${action}`, { method: 'POST' })
    await refreshStatus()
  }
  catch (error) {
    errorText.value = `${action === 'pause' ? '暂停' : '恢复'}失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = null
  }
}

async function toggleWorld(world: CorticoWorld) {
  if (busy.value)
    return
  const next = !worldEnabled(world)
  busy.value = `world:${world.id}`
  errorText.value = ''
  try {
    await api('/api/worlds/activation', {
      method: 'POST',
      body: JSON.stringify({ id: world.id, enabled: next }),
    })
    await refreshWorlds()
  }
  catch (error) {
    errorText.value = `切换世界 ${world.id} 失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = null
  }
}

function reload() {
  frameKey.value += 1
  void refreshAll()
}

function applyUrl() {
  const next = normalize(draft.value)
  draft.value = next
  baseUrl.value = next
  persist(next)
  reload()
}

function openExternal() {
  window.open(`${displayBase.value}/`, '_blank', 'noopener,noreferrer')
}

onMounted(() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      baseUrl.value = normalize(stored)
      draft.value = baseUrl.value
    }
  }
  catch {}
  void refreshAll()
  pollTimer = setInterval(() => void refreshStatus(), 10_000)
})

onBeforeUnmount(() => {
  if (pollTimer)
    clearInterval(pollTimer)
})
</script>

<template>
  <div h-full flex="~ col gap-3" font-normal>
    <!-- 地址栏 -->
    <div flex="~ row items-center gap-2">
      <input
        v-model="draft"
        type="text"
        spellcheck="false"
        placeholder="http://127.0.0.1:7788"
        border="~ neutral-300/50 dark:neutral-700/50 rounded-lg"
        bg="neutral-100/60 dark:neutral-800/40"
        px-3 py-2 text-sm font-mono
        min-w-0 flex-1 outline-none
        @keyup.enter="applyUrl"
      >
      <button
        type="button" rounded-lg bg="neutral-200/70 dark:neutral-700/50" px-3 py-2 text-sm
        hover:bg="neutral-300/70 dark:neutral-600/50" @click="applyUrl"
      >
        连接
      </button>
      <button
        type="button" rounded-lg bg="neutral-200/70 dark:neutral-700/50" px-3 py-2 text-sm
        hover:bg="neutral-300/70 dark:neutral-600/50" @click="reload"
      >
        刷新
      </button>
      <button
        type="button" rounded-lg bg="neutral-200/70 dark:neutral-700/50" px-3 py-2 text-sm
        hover:bg="neutral-300/70 dark:neutral-600/50" @click="openExternal"
      >
        浏览器打开
      </button>
    </div>

    <!-- 状态与快捷控制 -->
    <div
      v-if="online"
      flex="~ col gap-3" rounded-xl border="~ neutral-300/40 dark:neutral-700/40"
      bg="neutral-100/40 dark:neutral-900/30" p-3
    >
      <div flex="~ row flex-wrap items-center gap-3" text-xs>
        <span text="green-600 dark:green-400">● 在线 {{ uptimeText }}</span>
        <span v-if="hostLabel" text="neutral-500">{{ hostLabel }}</span>
        <span v-if="status?.modelConnection" text="neutral-600 dark:neutral-400">
          {{ status.modelConnection.name }} · {{ status.modelConnection.model }}
          <span v-if="status.modelConnection.ready === false" text="amber-600 dark:amber-400">（未就绪）</span>
        </span>
        <span v-if="status?.loop" text="neutral-500">
          {{ status.loop.messageCount ?? 0 }} 条消息 · {{ status.loop.batchesHandled ?? 0 }} 批 {{ usageText ? ` · ${usageText}` : '' }}
        </span>
      </div>

      <div flex="~ row flex-wrap items-center gap-2">
        <span text="xs neutral-500">人格</span>
        <select
          v-model="selectedDeployment"
          :disabled="busy !== null || deployments.length === 0"
          rounded-lg bg="neutral-200/70 dark:neutral-700/50" px-2 py-1.5 text-xs
          border="~ neutral-300/50 dark:neutral-700/50"
        >
          <option v-if="deployments.length === 0" value="">未找到部署</option>
          <option v-for="item in deployments" :key="item.name" :value="item.name">
            {{ item.displayName }} ({{ item.bot }})
          </option>
        </select>
        <button
          type="button" rounded-lg bg="neutral-200/70 dark:neutral-700/50" px-3 py-1.5 text-xs
          hover:bg="neutral-300/70 dark:neutral-600/50"
          :disabled="busy !== null || !selectedDeployment"
          @click="applyDeployment"
        >
          {{ busy?.startsWith('deploy:') ? '切换中…' : '切换' }}
        </button>

        <div flex-1 />

        <button
          type="button" rounded-lg px-3 py-1.5 text-xs
          :class="isPaused
            ? 'bg-green-500/20 text-green-700 dark:text-green-300'
            : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'"
          :disabled="busy !== null"
          @click="toggleRun"
        >
          {{ isPaused ? '▶ 恢复运行' : '⏸ 暂停运行' }}
        </button>
      </div>

      <div flex="~ row flex-wrap items-center gap-2">
        <span text="xs neutral-500">模式</span>
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          rounded-lg px-3 py-1.5 text-xs
          :class="currentMode === option.value
            ? 'bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-400/50'
            : 'bg-neutral-200/70 dark:bg-neutral-700/50 hover:bg-neutral-300/70 dark:hover:bg-neutral-600/50'"
          :disabled="busy !== null"
          @click="option.value && switchMode(option.value)"
        >
          {{ option.label ?? option.value }}
          <span v-if="busy === `mode:${option.value}`">…</span>
        </button>
        <span v-if="tickMinutes !== null" text="xs neutral-500">心跳 {{ tickMinutes }} 分钟</span>
      </div>

      <div v-if="worlds.length" flex="~ row flex-wrap items-center gap-2">
        <span text="xs neutral-500">世界</span>
        <button
          v-for="world in worlds"
          :key="world.id"
          type="button"
          rounded-lg px-2.5 py-1 text-xs
          :class="worldEnabled(world)
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-400/40'
            : 'bg-neutral-200/60 dark:bg-neutral-800/60 text-neutral-500'"
          :disabled="busy !== null"
          :title="world.status"
          @click="toggleWorld(world)"
        >
          {{ world.label ?? world.name ?? world.id }}
          <span v-if="busy === `world:${world.id}`">…</span>
        </button>
      </div>

      <div v-if="errorText" text="xs red-500">{{ errorText }}</div>
    </div>

    <div v-else-if="online === false" rounded-xl border="~ amber-400/40" bg="amber-500/10" p-3 text-xs>
      <div text="amber-700 dark:amber-300">连不上 {{ displayBase }}</div>
      <div mt-1 text="neutral-600 dark:neutral-400">
        <template v-if="hostLabel">
          {{ hostLabel }}
        </template>
        <template v-else>
          先启动 Cortico：在 <code font-mono>Cortico</code> 目录执行
          <code font-mono>node bin/cortico.mjs airi</code>
        </template>
      </div>
      <button
        v-if="canStartHosted"
        type="button"
        mt-2 rounded-lg bg="sky-500/20" px-3 py-1.5 text-xs
        text="sky-700 dark:sky-300"
        :disabled="busy !== null"
        @click="startHosted"
      >
        {{ busy === 'host:start' ? '正在启动…' : '让 AIRI 启动 Cortico' }}
      </button>
    </div>

    <!-- Cortico 官方 WebUI -->
    <div relative min-h-0 flex-1 overflow-hidden rounded-xl border="~ neutral-300/50 dark:neutral-700/50">
      <div
        v-if="online === false"
        absolute inset-0 flex items-center justify-center
        text="sm neutral-500" bg="neutral-100/40 dark:neutral-900/40"
      >
        暂无连接
      </div>
      <iframe
        v-else
        :key="frameKey"
        :src="frameSrc"
        title="Cortico WebUI"
        h-full w-full border-0
        allow="clipboard-read; clipboard-write; microphone; camera; autoplay"
      />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: Cortico
  subtitle: 世界调度与记忆
  description: 模式切换、运行控制、世界开关与完整 WebUI
  icon: i-solar:planet-4-bold-duotone
  settingsEntry: true
  order: 10
  stageTransition:
    name: slide
</route>
