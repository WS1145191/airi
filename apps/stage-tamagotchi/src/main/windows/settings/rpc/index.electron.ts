import type { BrowserWindow } from 'electron'

import type { I18n } from '../../../libs/i18n'
import type { ServerChannel } from '../../../services/airi/channel-server'
import type { GodotStageManager } from '../../../services/airi/godot-stage'
import type { IOTraceRecordingService } from '../../../services/airi/io-trace-recording'
import type { McpManager } from '../../../services/airi/mcp-servers'
import type { AutoUpdater } from '../../../services/electron/auto-updater'
import type { CorticoService } from '../../../services/electron/cortico-service'
import type { GlobalShortcutService } from '../../../services/electron/global-shortcut'
import type { DevtoolsWindowManager } from '../../devtools'
import type { SpotlightWindowManager } from '../../spotlight'
import type { WidgetsWindowManager } from '../../widgets'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { ipcMain } from 'electron'

import {
  electronCenterMainWindow,
  electronEnsureCorticoStarted,
  electronGetCorticoStatus,
  electronOpenDevtoolsWindow,
  electronOpenSettingsDevtools,
  electronSpotlightShortcutGet,
  electronSpotlightShortcutSet,
} from '../../../../shared/eventa'
import { createAuthService } from '../../../services/airi/auth'
import { createGodotStageService } from '../../../services/airi/godot-stage'
import { registerIOTraceRecording } from '../../../services/airi/io-trace-recording/register'
import { createMcpServersService } from '../../../services/airi/mcp-servers'
import { createWidgetsService } from '../../../services/airi/widgets'
import { createAutoUpdaterService } from '../../../services/electron'
import { centerWindowOnDisplay } from '../../shared/display'
import { setupBaseWindowElectronInvokes } from '../../shared/window'

/**
 * Registers what the settings pages ask of the window that shows them: the Spotlight shortcut and the devtools. Each
 * window registers the global shortcuts itself, because the main window needs them for Push to Talk too.
 *
 * Use when:
 * - A window shows settings pages, such as the settings window or the main window in its fullscreen mode.
 */
export function setupSettingsPageInvokes(params: {
  context: ReturnType<typeof createContext>['context']
  window: BrowserWindow
  spotlightWindow: SpotlightWindowManager
  devtoolsWindow: DevtoolsWindowManager
}) {
  const { context, window } = params
  defineInvokeHandler(context, electronSpotlightShortcutGet, () => params.spotlightWindow.getShortcutAccelerator())
  defineInvokeHandler(context, electronSpotlightShortcutSet, (payload) => {
    if (payload?.accelerator === undefined)
      throw new TypeError('electronSpotlightShortcutSet called with invalid payload')

    return params.spotlightWindow.updateShortcutAccelerator(payload.accelerator)
  })
  defineInvokeHandler(context, electronOpenSettingsDevtools, async () => window.webContents.openDevTools({ mode: 'detach' }))
  defineInvokeHandler(context, electronOpenDevtoolsWindow, async (payload) => {
    await params.devtoolsWindow.openWindow(payload)
  })
}

export async function setupSettingsWindowInvokes(params: {
  settingsWindow: BrowserWindow
  widgetsManager: WidgetsWindowManager
  autoUpdater: AutoUpdater
  devtoolsWindow: DevtoolsWindowManager
  getMainWindow?: () => BrowserWindow | undefined
  serverChannel: ServerChannel
  godotStageManager: GodotStageManager
  mcpManager: McpManager
  i18n: I18n
  globalShortcut: GlobalShortcutService
  spotlightWindow: SpotlightWindowManager
  ioTraceRecording: IOTraceRecordingService
  cortico?: CorticoService
}) {
  // TODO: once we refactored eventa to support window-namespaced contexts,
  // we can remove the setMaxListeners call below since eventa will be able to dispatch and
  // manage events within eventa's context system.
  ipcMain.setMaxListeners(0)

  const { context } = createContext(ipcMain, params.settingsWindow)

  await setupBaseWindowElectronInvokes({ context, window: params.settingsWindow, i18n: params.i18n, serverChannel: params.serverChannel })

  createWidgetsService({ context, widgetsManager: params.widgetsManager, window: params.settingsWindow })
  createAutoUpdaterService({ context, window: params.settingsWindow, service: params.autoUpdater })
  createMcpServersService({ context, manager: params.mcpManager })
  createGodotStageService({ context, manager: params.godotStageManager, window: params.settingsWindow })
  createAuthService({ context, window: params.settingsWindow })
  const stopIOTraceRecording = registerIOTraceRecording(context, params.ioTraceRecording)
  params.settingsWindow.once('closed', stopIOTraceRecording)

  // Register the global shortcut service for the settings window.
  params.globalShortcut.registerWindow({ context, window: params.settingsWindow })
  setupSettingsPageInvokes({
    context,
    window: params.settingsWindow,
    spotlightWindow: params.spotlightWindow,
    devtoolsWindow: params.devtoolsWindow,
  })
  defineInvokeHandler(context, electronCenterMainWindow, () => centerWindowOnDisplay(params.getMainWindow?.()))

  // Cortico 托管状态：设置页用它显示「由 AIRI 托管 / 外部实例 / 未启动」
  const cortico = params.cortico
  defineInvokeHandler(context, electronGetCorticoStatus, () => {
    if (!cortico) {
      return {
        state: 'unavailable' as const,
        port: 7788,
        pid: null,
        managed: false,
        rootDir: null,
        lastError: 'Cortico 服务未初始化',
      }
    }
    return cortico.getStatus()
  })
  defineInvokeHandler(context, electronEnsureCorticoStarted, async () => {
    if (!cortico)
      throw new Error('Cortico 服务未初始化')
    return await cortico.ensureStarted()
  })

  return context
}
