import type { ChildProcess } from 'node:child_process'

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  /** 当前部署名（`deployments/<名>/`）。切 bot 就是换这个。 */
  deployment: string
  /** 由本进程托管时才有（spawn 出的 pid） */
  pid: number | null
  /** 是否由 AIRI 托管（false = 复用了已在跑的实例，或没在跑） */
  managed: boolean
  /** 仓库根目录，找不到时为 null */
  rootDir: string | null
  lastError?: string
}

/** 一份可切换的部署。 */
export interface CorticoDeployment {
  /** `deployments/` 下的目录名，也是 `bin/cortico.mjs` 的参数 */
  name: string
  /** `deployment.json` 里的 bot 代码包名 */
  bot: string
  /** 该部署 config.json 里写的端口 */
  port: number
  /** config.json 的 displayName，没写就用部署名 */
  displayName: string
  /** 当前正在跑的那一份 */
  active: boolean
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

/**
 * 读一份部署，拼成可切换的条目。
 *
 * `deployment.json` 只有 `bot` 一个字段（选哪个 bot 代码包），端口和显示名在 `config.json`
 * 里 —— 那是部署自己的配置，不是服务该猜的东西。读不懂的目录直接跳过：`deployments/` 下
 * 也可能有备份目录或半成品，把它们的名字列进下拉框只会让用户点出一个起不来的东西。
 */
function readDeployment(rootDir: string, name: string): CorticoDeployment | null {
  const dir = join(rootDir, 'deployments', name)
  // 手写的 JSON 常带 BOM（PowerShell 的 `Set-Content -Encoding UTF8` 默认就加），
  // 而 `JSON.parse` 会在 BOM 上直接抛 —— 去掉再解析，否则用户自己建的部署永远列不出来。
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  try {
    const manifest = readJson(join(dir, 'deployment.json')) as { bot?: unknown }
    if (typeof manifest.bot !== 'string' || !manifest.bot)
      return null

    let port = DEFAULT_CORTICO_PORT
    let displayName = name
    const configPath = join(dir, 'config.json')
    if (existsSync(configPath)) {
      const config = readJson(configPath) as {
        displayName?: unknown
        web?: { port?: unknown }
      }
      if (typeof config.web?.port === 'number' && config.web.port > 0)
        port = config.web.port
      if (typeof config.displayName === 'string' && config.displayName)
        displayName = config.displayName
    }

    return { name, bot: manifest.bot, port, displayName, active: false }
  }
  catch {
    return null
  }
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

/**
 * Cortico 每次启动都从 paused 开始 —— 它自己的设计是让操作者决定何时放它跑。
 *
 * 但在这台机器上没人会去点那个按钮：Cortico 只是 AIRI 的后端，用户眼里只有一个桌宠。
 * 停在 paused 的表现是「消息发进去了、界面毫无反应」，排查时极难联想到暂停。
 * 所以启动完就替用户按一次 resume；已经是运行态时这个调用是幂等的。
 */
async function resumeIfPaused(port: number, timeoutMs = 4000): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: controller.signal })
    if (!response.ok)
      return
    const status = await response.json() as { loop?: { paused?: boolean } }
    if (!status.loop?.paused)
      return
    await fetch(`http://127.0.0.1:${port}/api/run/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    log.log('Cortico was paused on start, resumed')
  }
  catch (error) {
    // 拉不起来不是致命错误：连接时会再报，这里吞掉以免挡住启动流程。
    log.withError(error).warn('Failed to resume Cortico')
  }
  finally {
    clearTimeout(timer)
  }
}

export class CorticoService {
  /**
   * 端口与部署名不再是 readonly：切 bot 就是「换一个部署再起一次」，
   * 而这两样都是 `bin/cortico.mjs` 启动参数的一部分。
   */
  private port: number
  private deployment: string
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
      deployment: this.deployment,
      pid: managed ? (this.child?.pid ?? null) : null,
      managed,
      rootDir: this.rootDir,
      lastError: this.lastError,
    }
  }

  /** 当前部署名。切换后会变，所以调用方不要缓存。 */
  getDeploymentName(): string {
    return this.deployment
  }

  /** 当前 WebUI 端口。切换后会变。 */
  getPort(): number {
    return this.port
  }

  /**
   * 列出所有可切换的部署。
   *
   * 只读 `deployments/` 下带 `deployment.json` 的目录，不读 WebUI —— 那边只认当前这一份，
   * 切换选项必须来自磁盘才完整（WebUI 自己也没有列其它部署的接口）。
   */
  listDeployments(): CorticoDeployment[] {
    const root = this.rootDir ?? this.resolveRoot()
    if (!root)
      return []
    try {
      return readdirSync(join(root, 'deployments'), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => readDeployment(root, entry.name))
        .filter((item): item is CorticoDeployment => item !== null)
        .map(item => ({ ...item, active: item.name === this.deployment }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
    catch {
      return []
    }
  }

  /**
   * 切到另一份部署。
   *
   * 顺序是「先停再起」，不能并行：两份部署可能共用同一个 `paths.memory` 目录，
   * 两份进程同时写同一批文件就是互相覆盖（见 docs/deployment.md 的记忆目录约定）。
   * 冷启动一份 cortiv 实测不到 1 秒，这里不值得为省那点时间去冒数据风险。
   */
  async switchTo(deployment: string, port?: number): Promise<CorticoStatus> {
    const root = this.rootDir ?? this.resolveRoot()
    if (!root) {
      this.state = 'unavailable'
      this.lastError = 'Cortico 仓库未找到'
      return this.getStatus()
    }

    const target = readDeployment(root, deployment)
    if (!target) {
      this.state = 'error'
      this.lastError = `找不到部署 ${deployment}（deployments/${deployment}/deployment.json）`
      return this.getStatus()
    }

    // 已经是这一份就不用再折腾进程。
    if (target.name === this.deployment && this.state === 'online')
      return this.getStatus()

    log.withFields({ from: this.deployment, to: target.name }).log('switching Cortico deployment')

    await this.stop()
    this.deployment = target.name
    this.port = port ?? (target.port || DEFAULT_CORTICO_PORT)
    this.rootDir = root
    this.lastError = undefined

    return await this.ensureStarted()
  }

  /** Cortico 仓库根。还没探测到（没启动过）时为 null。记忆目录要拼在它下面。 */
  getRootDir(): string | null {
    return this.rootDir
  }

  /** 部署名。记忆在 `<rootDir>/deployments/<deployment>/workspace/` 下。 */
  getDeployment(): string {
    return this.deployment
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
      // 复用一个手动启动的实例时同样要放它跑，否则复用等于连上一个冻住的进程。
      await resumeIfPaused(this.port)
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
        await resumeIfPaused(this.port)
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
