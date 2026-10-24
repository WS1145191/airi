import type { CorticoMemoryRecord } from '../../shared/eventa/cortico-memory'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'

import {
  corticoMemoryList,
  corticoMemoryRemove,
  corticoMemoryStatus,
  corticoMemoryWrite,
} from '../../shared/eventa/cortico-memory'

/**
 * 记忆目录的渲染进程侧。
 *
 * 真正的读写在主进程（`main/services/airi/cortico-memory`），这里只负责把调用转过去 ——
 * 渲染进程跑在 `file://` 下没有 fs，写不了文件。
 *
 * 与 `useMemoryStore` 的关系：那个 store 仍然是权威（localStorage 是各窗口一致性的来源），
 * 每次写/删之后把条目镜像到这个目录，于是 Cortico 那个进程也能读到同一批事实。
 * 方向是单向的：两边同时写同一批文件、又没有共享时钟，就只能做合并，
 * 而合并到一半的记忆比不完整的记忆更糟 —— 所以这边答自己的，文件答另一边的。
 */

let context: ReturnType<typeof createContext>['context'] | undefined
let dispose: (() => void) | undefined

function getContext() {
  if (!context) {
    const created = createContext(window.electron.ipcRenderer)
    context = created.context
    dispose = created.dispose
  }
  return context
}

/** 当前环境能不能用（浏览器预览里没有 ipcRenderer） */
export function isCorticoMemoryAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.electron?.ipcRenderer
}

/** 列出记忆目录里的全部条目。读不到时返回空数组，不抛 —— 记忆读不到不该让对话崩掉。 */
export async function listCorticoMemory(): Promise<CorticoMemoryRecord[]> {
  if (!isCorticoMemoryAvailable())
    return []
  try {
    return await defineInvoke(getContext(), corticoMemoryList)(undefined)
  }
  catch {
    return []
  }
}

/** 写一条（同名覆盖）。失败返回 null。 */
export async function writeCorticoMemory(entry: { name: string, description: string, body: string }): Promise<CorticoMemoryRecord | null> {
  if (!isCorticoMemoryAvailable())
    return null
  try {
    const result = await defineInvoke(getContext(), corticoMemoryWrite)(entry)
    return result.ok ? result.entry : null
  }
  catch {
    return null
  }
}

/** 删一条。返回是否真的删掉了。 */
export async function removeCorticoMemory(name: string): Promise<boolean> {
  if (!isCorticoMemoryAvailable())
    return false
  try {
    const result = await defineInvoke(getContext(), corticoMemoryRemove)({ name })
    return result.ok
  }
  catch {
    return false
  }
}

/** 读目录状态（路径、条数），设置页要显示。 */
export async function getCorticoMemoryStatus() {
  if (!isCorticoMemoryAvailable()) {
    return {
      directory: '',
      exists: false,
      count: 0,
      error: '记忆目录只在桌面版可用（浏览器预览里没有主进程）',
    }
  }
  try {
    return await defineInvoke(getContext(), corticoMemoryStatus)(undefined)
  }
  catch (error) {
    return {
      directory: '',
      exists: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 释放 ipc 通道。窗口卸载时调用。 */
export function disposeCorticoMemory(): void {
  dispose?.()
  context = undefined
  dispose = undefined
}
