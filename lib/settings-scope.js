/**
 * Host-version-adaptive settings scope.
 *
 * DSH 改过「插件如何声明可编辑配置」：
 * - 旧宿主（0.1.x）提供 `settings.register(ns, schema, opts)`，插件持有一个可变
 *   来源引用，并在每次操作时读取注册后的 scope。
 * - 新宿主（0.2.0-rc.x）移除了该方法：设置页由 Loader 行自己的 `Config` schema
 *   派生，`SettingsForms` 只剩 `configure/describe/update/replace/mutate`，
 *   宿主解析并校验本行 config 后交给 `apply(ctx, config)`，编辑后重新解析
 *   （`ctx.fiber.config` 始终是最新值）。
 *
 * 因此无条件调用 `settings.register` 会在新宿主上抛
 * `TypeError: ctx.settings.register is not a function`，直接中断整个插件 fiber
 * （实测：DSH 0.2.0-rc.2 + dsh-memory-eternal 0.7.0，index.js:97）。
 * 这里探测该方法，缺失时退化为「读 Loader 行 config」。
 * @module dsh-memory-eternal/settings-scope
 */

/** 把未知服务收窄成旧宿主的注册形状。 */
function legacyRegister(settings) {
  if (settings === null || typeof settings !== 'object') return undefined
  const candidate = settings.register
  return typeof candidate === 'function' ? candidate.bind(settings) : undefined
}

/**
 * 在支持的宿主上注册插件的设置段，否则退化到 Loader 管理的行 config。
 *
 * @param settings - 注入的 `ctx.settings` 服务（宿主未合成时为 undefined）。
 * @param namespace - 设置命名空间 / Loader 行 id（此处为 `memory-eternal`）。
 * @param schema - 插件的 schemastery `Config`。
 * @param entryConfig - 宿主传入 `apply` 的 config。
 * @param liveConfig - 可选：读取当前行 config 的函数（新宿主用，返回最新值）。
 * @returns 与宿主版本无关的当前配置读取器。
 */
export function resolveSettingsScope(settings, namespace, schema, entryConfig, liveConfig) {
  const register = legacyRegister(settings)
  if (register !== undefined) {
    // 旧宿主：继续走注册后的 scope，编辑无需重启 fiber 即可见。
    const scope = register(namespace, schema, { base: entryConfig ?? {} })
    return {
      mode: 'scope',
      get: () => scope.get(),
      watch: (callback) => (typeof scope.watch === 'function' ? scope.watch(callback) : () => {}),
      describe: (options) => (typeof scope.describe === 'function' ? scope.describe(options) : []),
    }
  }
  // 新宿主：配置由 Loader 行驱动；行被编辑后宿主自行重新解析。
  const read = () => {
    if (typeof liveConfig === 'function') {
      try {
        const live = liveConfig()
        if (live !== undefined && live !== null) return live
      } catch { /* 读不到就用启动时的入参 */ }
    }
    return entryConfig ?? {}
  }
  return {
    mode: 'entry',
    get: read,
    // 新宿主不暴露配置变更回调：行编辑后宿主会重新解析（必要时由用户重启），
    // 这里返回一个空退订函数，保证插件里 `settings.watch(...)` 调用不抛错。
    watch: () => () => {},
    describe: () => [],
  }
}
