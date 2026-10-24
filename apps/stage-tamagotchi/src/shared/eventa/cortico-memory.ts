import { defineInvokeEventa } from '@moeru/eventa'

/**
 * AIRI 记忆的存取合约。
 *
 * 记忆落在 Cortico 部署的 `workspace/memory/` 下（一条事实一个 markdown 文件），
 * 而不是渲染进程的 localStorage。这样 Cortico 用普通的 `read_file` 就能读到 AIRI 记下的东西，
 * 两套人格读的是同一份记忆，而不是各记一套。
 *
 * 读写都必须走主进程：渲染进程跑在 `file://` 下，没有 fs。
 */

/** 一条记忆。字段与 AIRI 的 `MemoryEntry` 对齐，省掉一层映射。 */
export interface CorticoMemoryRecord {
  /** kebab case 的名字，同时也是文件名（不含 `.md`） */
  name: string
  /** 一行索引：能一行说完就写事实本身，否则写「什么时候用得上」 */
  description: string
  /** 正文 */
  body: string
  /** 最后写入时间（毫秒）；读旧文件时可能为 0 */
  updatedAt: number
}

/** 记忆目录的状态，设置页要显示路径和条数 */
export interface CorticoMemoryStatus {
  /** 记忆目录绝对路径 */
  directory: string
  /** 目录是否已经存在 */
  exists: boolean
  /** 条数 */
  count: number
  /** 目录不可用时的原因（例如找不到 Cortico 仓库） */
  error?: string
}

/** 列出全部记忆 */
export const corticoMemoryList = defineInvokeEventa<CorticoMemoryRecord[], void>(
  'eventa:invoke:airi:cortico-memory:list',
)

/** 写一条（同名覆盖） */
export const corticoMemoryWrite = defineInvokeEventa<
  { ok: true, entry: CorticoMemoryRecord } | { ok: false, error: string },
  { name: string, description: string, body: string }
>('eventa:invoke:airi:cortico-memory:write')

/** 删一条 */
export const corticoMemoryRemove = defineInvokeEventa<
  { ok: true } | { ok: false, error: string },
  { name: string }
>('eventa:invoke:airi:cortico-memory:remove')

/** 读目录状态 */
export const corticoMemoryStatus = defineInvokeEventa<CorticoMemoryStatus, void>(
  'eventa:invoke:airi:cortico-memory:status',
)
