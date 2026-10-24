import type { ChildProcess } from 'node:child_process'

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { useLogg } from '@guiiai/logg'

/**
 * Cortico 进程托管
 *
 * Cortico 以独立 Node 进程运行（`node bin/cortico.mjs <部署名>`），WebUI 默认监听
 * 127.0.0.1:7788。这里负责在 AIRI 启动时把它带起来，并在 AIRI 退出时收回去。
 *
 * 三条硬规则：
 *   1. **已在线就绝不动它**。如果 7788 上已经有 Cortico（用户自己开的，或上一次
 *      AIRI 没退干净留下的），直接复用，绝不重复拉起、也绝不杀掉它 —— 那是用户的进程。
 *   2. **找不到就静默降级**。Cortico 是可选的，仓库路径不存在时只标记 unavailable，
 *      不抛错、不阻塞 AIRI 启动。
 *   3. **只回收自己生的那个**。退出时只 kill 本模块 spawn 出来的 pid，靠 pid 比对。
 */

const log = useLogg('cortico-service').useGlobalConfig()

/** Cortico 的默认 WebUI 端口（cormini bot 的 web.port） */
export const DEFAULT_CORTICO_PORT = 7788

/** 启动后等待 WebUI 就绪的上限 */
const READY_TIMEOUT_MS = 120_000
/** 就绪轮询间隔 */
const READY_POLL_MS = 500

export type CorticoState = 'starting' | 'online' | 'external' | 'unavailable' | 'error' | 'stopped'

export interface CorticoStatus {
  state: CorticoState
  port: number
  /** 由本进程托管时才有（spawn 出的 pid） */
  pid: number | null
  /** 是否由 AIRI 托管（false = 复用了已在跑的实例，或没在跑） */
  managed: boolean
  /** 仓库根目录，找不到时为 null */
  rootDir: string | null
  lastError?: string
}

export interface CorticoServiceOptions {
  /** Cortico 仓库根目录。不给则按候选列表自动探测。 */
  rootDir?: string
  /** 部署名，传给 bin/cortico.mjs 的第一个参数 */
  deployment?: string
  /** WebUI 端口 */
  port?: number
  /** node 可执行文件。不给则用 process.execPath（Electron 自带，需 ELECTRON_RUN_AS_NODE） */
  nodePath?: string
}

/** 探测 Cortico 仓库根的候选位置 */
function candidateRoots(): string[] {
  const roots: string[] = []
  const envRoot = process.env.CORTICO_REPO
  if (envRoot)
    roots.push(envRoot)

  // 与 AIRI 并列的常见位置
  roots.push(
    resolve(process.cwd(), 'Cortico'),
    resolve(process.cwd(), '..', 'Cortico'),
    'C:\\Users\\114514\\Documents\\deepseek-harness\\default-workspace\\Cortico',
  )
  return roots
}

/** 一个目录算不算 Cortico 仓库根 */
function isCorticoRoot(dir: string): boolean {
  return existsSync(join(dir, 'bin', 'cortico.mjs'))
}

/** 探测 WebUI 是否已经在线 */
async function probe(port: number, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: controller.signal })
    return response.ok
  }
  catch {
    return false
  }
  finally {
    clearTimeout(timer)
  }
}

export class CorticoService {
  private readonly port: number
  private readonly deployment: string
  private readonly configuredRoot: string | undefined
  private readonly configuredNode: string | undefined

  private child: ChildProcess | undefined
  private rootDir: string | null = null
  private state: CorticoState = 'stopped'
  private lastError: string | undefined
  private starting: Promise<CorticoStatus> | undefined

  constructor(options: CorticoServiceOptions = {}) {
    this.port = options.port ?? DEFAULT_CORTICO_PORT
    this.deployment = options.deployment ?? 'airi'
    this.configuredRoot = options.rootDir
    this.configuredNode = options.nodePath
  }

  getStatus(): CorticoStatus {
    const managed = this.child !== undefined && this.child.exitCode === null
    return {
      state: this.state,
      port: this.port,
      pid: managed ? (this.child?.pid ?? null) : null,
      managed,
      rootDir: this.rootDir,
      lastError: this.lastError,
    }
  }

  /**
   * 确保 Cortico 在跑。幂等：重复调用共用同一个 promise。
   */
  async ensureStarted(): Promise<CorticoStatus> {
    if (this.starting)
      return await this.starting

    this.starting = this.startInternal()
    try {
      return await this.starting
    }
    finally {
      this.starting = undefined
    }
  }

  private async startInternal(): Promise<CorticoStatus> {
    // 1) 已在跑？那不是我该管的
    if (await probe(this.port)) {
      log.log(`Cortico already listening on ${this.port}, reusing it`)
      this.state = 'external'
      this.lastError = undefined
      return this.getStatus()
    }

    // 2) 找仓库
    const root = this.resolveRoot()
    if (!root) {
      log.log('Cortico repository not found, skipping autostart')
      this.state = 'unavailable'
      this.lastError = 'Cortico 仓库未找到'
      return this.getStatus()
    }
    this.rootDir = root

    // 3) 找 node
    const node = this.resolveNode()
    if (!node) {
      this.state = 'unavailable'
      this.lastError = '未找到可用的 node 可执行文件'
      return this.getStatus()
    }

    // 4) 拉起
    this.state = 'starting'
    this.lastError = undefined
    log.withFields({ root, node, deployment: this.deployment, port: this.port }).log('starting Cortico')

    try {
      this.child = spawn(node, [join('bin', 'cortico.mjs'), this.deployment], {
        cwd: root,
        // ELECTRON_RUN_AS_NODE：让 Electron 自带的 node 以纯 node 模式跑 bin 脚本
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch (error) {
      this.state = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      log.withError(error).error('failed to spawn Cortico')
      return this.getStatus()
    }

    const child = this.child

    // 子进程的输出进日志，但不刷屏
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text)
        log.log(`[cortico] ${text}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text)
        log.warn(`[cortico] ${text}`)
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        log.withFields({ code, signal }).log('Cortico process exited')
        this.child = undefined
        if (this.state !== 'stopped')
          this.state = code === 0 ? 'stopped' : 'error'
      }
    })
    child.on('error', (error) => {
      this.lastError = error.message
      log.withError(error).error('Cortico process error')
    })

    // 5) 等它起来
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await probe(this.port)) {
        this.state = 'online'
        log.withFields({ pid: child.pid }).log('Cortico is ready')
        return this.getStatus()
      }
      if (child.exitCode !== null) {
        this.state = 'error'
        this.lastError = `Cortico 启动后立即退出（exit ${child.exitCode}）`
        return this.getStatus()
      }
      await new Promise(r => setTimeout(r, READY_POLL_MS))
    }

    this.state = 'error'
    this.lastError = `等待 Cortico 就绪超时（${READY_TIMEOUT_MS / 1000}s）`
    log.error(this.lastError)
    return this.getStatus()
  }

  /**
   * 停掉**由本服务启动**的 Cortico。外部实例一律不动。
   */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = undefined
      this.state = 'stopped'
      return
    }

    log.withFields({ pid: child.pid }).log('stopping managed Cortico')
    this.state = 'stopped'

    // 先温和，给 Cortico 自己收尾的机会
    try {
      child.kill()
    }
    catch {}

    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        // 超时强杀，同样只针对自己的 pid
        try {
          child.kill('SIGKILL')
        }
        catch {}
        done()
      }, 8000)

      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
    })

    this.child = undefined
  }

  private resolveRoot(): string | null {
    if (this.configuredRoot) {
      return isCorticoRoot(this.configuredRoot) ? this.configuredRoot : null
    }
    for (const candidate of candidateRoots()) {
      if (isCorticoRoot(candidate))
        return candidate
    }
    return null
  }

  private resolveNode(): string | null {
    if (this.configuredNode && existsSync(this.configuredNode))
      return this.configuredNode

    // Electron 自带 node：设置 ELECTRON_RUN_AS_NODE 后 process.execPath 就是 node
    if (process.execPath && existsSync(process.execPath))
      return process.execPath

    return null
  }
}
