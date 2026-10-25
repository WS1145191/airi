import { object, optional, picklist } from 'valibot'

import { createConfig } from '../libs/electron/persistence'

/**
 * Cortico 桥接的本地状态。
 *
 * `mode` 存在这里，**不再存在 Cortico 每份部署的 `config.json` 里**。
 *
 * 原因：`mode` 回答的是「AIRI 这边谁来开口」，是用户对壳的选择；而「用哪个人格」是 Cortico
 * 侧的事实。两者本来正交，之前都把 `mode` 写进各部署的 config，于是换人格必然带着模式一起换
 * ——切到一份写着 `normal` 的部署，营业模式自己就退回普通了，用户没碰过模式按钮。
 *
 * 现在这边是权威：切换人格时把当前 mode 推给新部署，而不是读它那份旧值回来。
 */
export const corticoConfigSchema = object({
  mode: optional(picklist(['normal', 'work']), 'normal'),
})

export function createCorticoConfig() {
  const config = createConfig('cortico', 'options.json', corticoConfigSchema)
  config.setup()

  return config
}
