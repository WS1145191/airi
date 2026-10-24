import type { Dirent } from 'node:fs'

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { useLogg } from '@guiiai/logg'

/**
 * AIRI 的记忆落在 Cortico 部署的 `workspace/memory/` 下。
 *
 * ## 为什么不是 localStorage
 * AIRI 自带的记忆存在渲染进程的 localStorage 里（`memory/entries`），Cortico 完全看不见。
 * 两边各记一套，用户切到营业模式后 Cortico 对普通模式聊过什么一无所知 —— 那就没有「共享人格」。
 * Cortico 的 workspace 本来就是它记忆的载体（它的 `list_files` / `read_file` / `write_file`
 * 直接作用在这个目录上），所以让 AIRI 也往这里写，两边读的是同一份文件。
 *
 * ## 为什么在主进程
 * 渲染进程跑在 `file://` 下，没有 Node 的 fs。写文件必须走主进程。
 *
 * ## 文件格式
 * 一条记忆一个 `.md` 文件，文件名就是记忆名（kebab case），正文分两段：
 *
 * ```
 * ---
 * description: 一行索引，写事实本身或者「什么时候用得上」
 * updatedAt: 1730000000000
 * ---
 * 正文
 * ```
 *
 * 选 markdown 是为了让 Cortico 用普通 `read_file` 就能读懂，不需要它懂额外格式。
 */

const log = useLogg('cortico-memory').useGlobalConfig()

/** 一条记忆。字段与 AIRI 的 `MemoryEntry` 对齐，省掉一层映射。 */
export interface CorticoMemoryEntry {
  name: string
  description: string
  body: string
  updatedAt: number
}

/** 记忆文件的扩展名 */
const EXTENSION = '.md'

/** 记忆名规整：与 AIRI `memoryName()` 同样的规则，保证两边算出来是同一个文件名。 */
export function memoryFileName(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/** 解析一个记忆文件。解析不出 frontmatter 时整段当正文，description 取首行 —— 手写的文件也能读。 */
export function parseMemoryFile(name: string, raw: string): CorticoMemoryEntry {
  const text = raw.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match)
    return { name, description: text.trim().split(/\r?\n/)[0] ?? '', body: text.trim(), updatedAt: 0 }

  const meta = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0)
      meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const updatedAt = Number(meta.get('updatedAt') ?? 0)
  return {
    name,
    description: meta.get('description') ?? '',
    body: match[2].trim(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  }
}

/** 序列化成文件内容。`description` 里的换行会破坏 frontmatter，压成一行。 */
export function serializeMemoryFile(entry: CorticoMemoryEntry): string {
  const description = entry.description.replace(/\s*\r?\n\s*/g, ' ').trim()
  return `---\ndescription: ${description}\nupdatedAt: ${entry.updatedAt}\n---\n${entry.body.trim()}\n`
}

export interface CorticoMemoryOptions {
  /**
   * Cortico 仓库根。
   *
   * 传函数而不是字符串：仓库根是启动时才探测出来的，构造这个对象的时候往往还是 null。
   * 每次用的时候现取，拿到的一定是探测过的那份。
   */
  rootDir: string | null | (() => string | null)
  /** 部署名，记忆在 `<rootDir>/deployments/<deployment>/workspace/memory/` */
  deployment?: string
}

export class CorticoMemory {
  private readonly readRootDir: () => string | null
  private readonly deployment: string

  constructor(options: CorticoMemoryOptions) {
    this.readRootDir = typeof options.rootDir === 'function' ? options.rootDir : () => options.rootDir as string | null
    this.deployment = options.deployment ?? 'airi'
  }

  /** 记忆目录的绝对路径。仓库根还没探测到时为 null。设置页要显示它，用户也可能想自己去看。 */
  get directory(): string | null {
    const rootDir = this.readRootDir()
    if (!rootDir)
      return null
    return resolve(rootDir, 'deployments', this.deployment, 'workspace', 'memory')
  }

  /** 目录不存在就建。Cortico 第一次跑起来时 workspace 里只有 CONSTITUTION.md。 */
  private async ensureDirectory(): Promise<string | null> {
    const dir = this.directory
    if (!dir)
      return null
    if (!existsSync(dir))
      await mkdir(dir, { recursive: true })
    return dir
  }

  /** 列出全部记忆。读不动的单个文件只警告，不影响其余。 */
  async list(): Promise<CorticoMemoryEntry[]> {
    const dir = await this.ensureDirectory()
    if (!dir)
      return []
    let names: Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    }
    catch (error) {
      log.withError(error).warn(`readdir failed: ${dir}`)
      return []
    }

    const entries: CorticoMemoryEntry[] = []
    for (const dirent of names) {
      if (!dirent.isFile() || !dirent.name.endsWith(EXTENSION))
        continue
      const name = dirent.name.slice(0, -EXTENSION.length)
      try {
        const raw = await readFile(join(dir, dirent.name), 'utf8')
        entries.push(parseMemoryFile(name, raw))
      }
      catch (error) {
        log.withError(error).warn(`read failed: ${dirent.name}`)
      }
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** 写一条。名字相同就覆盖 —— 与 AIRI 记忆「更新而不是加一份近似副本」的约定一致。 */
  async write(entry: { name: string, description: string, body: string }): Promise<CorticoMemoryEntry | null> {
    const name = memoryFileName(entry.name)
    const body = entry.body.trim()
    if (!name || !body)
      return null

    const dir = await this.ensureDirectory()
    // 仓库根没探测到（Cortico 没装或没起）时不写：写到一个猜出来的路径比丢失更难查。
    if (!dir)
      return null
    const stored: CorticoMemoryEntry = {
      name,
      description: entry.description.trim(),
      body,
      updatedAt: Date.now(),
    }
    await writeFile(join(dir, `${name}${EXTENSION}`), serializeMemoryFile(stored), 'utf8')
    return stored
  }

  /** 删一条。不存在时返回 false，让调用方回一句「没有这条」。 */
  async remove(name: string): Promise<boolean> {
    const key = memoryFileName(name)
    if (!key)
      return false
    const dir = this.directory
    if (!dir)
      return false
    const file = join(dir, `${key}${EXTENSION}`)
    if (!existsSync(file))
      return false
    try {
      await unlink(file)
      return true
    }
    catch (error) {
      log.withError(error).warn(`unlink failed: ${file}`)
      return false
    }
  }
}
