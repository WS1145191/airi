import type { CorticoMemory } from '.'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { existsSync } from 'node:fs'
import { ipcMain } from 'electron'

import {
  corticoMemoryList,
  corticoMemoryRemove,
  corticoMemoryStatus,
  corticoMemoryWrite,
} from '../../../../shared/eventa/cortico-memory'

/**
 * 把记忆目录暴露给渲染进程。
 *
 * 与别的 register 一样用不带 window 的 context：不管哪个窗口调用都到同一个实例。
 */
export function registerCorticoMemory(memory: CorticoMemory): () => void {
  const log = useLogg('cortico-memory-register').useGlobalConfig()
  const { context, dispose } = createContext(ipcMain)

  const disposers = [
    defineInvokeHandler(context, corticoMemoryList, () => memory.list()),
    defineInvokeHandler(context, corticoMemoryWrite, async ({ name, description, body }) => {
      try {
        const entry = await memory.write({ name, description, body })
        return entry ? { ok: true as const, entry } : { ok: false as const, error: '名字或正文为空' }
      }
      catch (error) {
        log.withError(error).warn('write failed')
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    }),
    defineInvokeHandler(context, corticoMemoryRemove, async ({ name }) => {
      try {
        return await memory.remove(name) ? { ok: true as const } : { ok: false as const, error: '没有这条记忆' }
      }
      catch (error) {
        log.withError(error).warn('remove failed')
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    }),
    defineInvokeHandler(context, corticoMemoryStatus, async () => {
      const directory = memory.directory
      if (!directory)
        return { directory: '', exists: false, count: 0, error: 'Cortico 仓库尚未探测到（进程还没起来）' }
      try {
        const entries = await memory.list()
        return { directory, exists: existsSync(directory), count: entries.length }
      }
      catch (error) {
        return {
          directory,
          exists: existsSync(directory),
          count: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  ]

  return () => {
    for (const disposeHandler of disposers)
      disposeHandler()
    dispose()
  }
}
