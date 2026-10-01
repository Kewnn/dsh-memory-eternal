// 记忆核心 · Config schema 测试：可热改（.volatile）与启动期字段的划线。
// 需要 @deepseek-ai/schemastery（插件的依赖）；未安装时整体跳过，不假装通过。
import { test } from 'node:test'
import assert from 'node:assert/strict'

let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = undefined
}

const { buildConfig, BOOT_ONLY_FIELDS, partitionPatch } = await import('../lib/config-schema.js')

test('partitionPatch: boot-only fields are split out so the rest can still save', () => {
  // 设置页常把整份表单一起提交；宿主对每个 op 逐个校验，混进启动期字段会让整次保存失败。
  const Config = { dict: { captureDebug: {}, captureMinChars: {}, autoWeb: {}, webPort: {}, watchdogAutoSpawn: {} } }
  const { live, bootOnly, unknown } = partitionPatch(Config, {
    captureDebug: true,
    captureMinChars: 120,
    autoWeb: false,
    webPort: 8123,
    notAField: 1,
  })
  assert.deepEqual(live, { captureDebug: true, captureMinChars: 120 })
  assert.deepEqual(bootOnly.sort(), ['autoWeb', 'webPort'])
  assert.deepEqual(unknown, ['notAField'])

  // 只动启动期字段 → 没有可热改项，调用方应当直接给「改 patch 行 + 重启」的提示
  const onlyBoot = partitionPatch(Config, { webPort: 8123 })
  assert.deepEqual(onlyBoot.live, {})
  assert.deepEqual(onlyBoot.bootOnly, ['webPort'])

  // 空 patch / undefined 不该炸
  assert.deepEqual(partitionPatch(Config, undefined).live, {})
  assert.deepEqual(partitionPatch(undefined, { a: 1 }).bootOnly, [])
  assert.deepEqual(partitionPatch(undefined, { a: 1 }).unknown, ['a'])
})

test('config schema: runtime fields are volatile, boot-only fields are not', { skip: z ? false : '@deepseek-ai/schemastery 未安装' }, () => {
  const Config = buildConfig(z)
  const dict = Config.dict ?? {}
  const keys = Object.keys(dict)
  assert.ok(keys.length > 30, `字段数异常：${keys.length}`)

  // 宿主 0.2.x：至少得有一个 volatile 字段，否则设置页直写会抛
  // `Plugin entry "memory-eternal" has no volatile fields`。
  const volatileKeys = keys.filter((k) => dict[k]?.meta?.volatile === true)
  assert.ok(volatileKeys.length > 0, '必须声明可热改字段')

  // 启动期字段必须**不**是 volatile：它们只在 apply 阶段读一次，热改会骗人。
  for (const k of BOOT_ONLY_FIELDS) {
    assert.ok(keys.includes(k), `启动期字段 ${k} 不存在于 schema`)
    assert.notEqual(dict[k]?.meta?.volatile, true, `${k} 是启动期字段，不该标 volatile`)
  }

  // 沉淀/召回相关的高频旋钮必须可热改（这正是设置页主要用来调的东西）。
  for (const k of ['enabled', 'autoCapture', 'autoRecall', 'captureMinChars', 'captureDebug', 'captureFallbackToRaw', 'distillEnabled', 'dedupThreshold', 'maxCardsPerDay', 'recallLimit', 'auditMode']) {
    assert.equal(dict[k]?.meta?.volatile, true, `${k} 应可热改`)
  }

  // 每个 volatile 字段都得落在固定对象路径上（宿主会拒绝 dict/动态键下的 volatile）。
  for (const k of volatileKeys) {
    const node = dict[k]
    assert.notEqual(node?.meta?.dict, true, `${k} 若是 dict 则不能标 volatile（宿主会抛 volatile fields require a fixed object path）`)
  }
})

test('config schema: defaults survive the volatile wrapper', { skip: z ? false : '@deepseek-ai/schemastery 未安装' }, () => {
  const Config = buildConfig(z)
  // 直接读 meta.default：宿主设置页同样只依赖 schema 的 meta，不依赖某版本的解析入口签名。
  const dflt = (k) => Config.dict[k]?.meta?.default
  assert.equal(dflt('autoCapture'), true)
  assert.equal(dflt('captureDebug'), false)
  assert.equal(dflt('captureFallbackToRaw'), false)
  assert.equal(dflt('captureMinChars'), 200)
  assert.equal(dflt('webPort'), 7999)
  assert.deepEqual(dflt('vaultProfiles'), [])
})

test('vol() is a no-op when the host schema library has no .volatile()', () => {
  // 老宿主 / 老 schemastery：没有 .volatile 时必须原样返回，否则整个插件起不来。
  const node = () => {
    const field = { meta: {}, default: () => field, min: () => field, max: () => field, role: () => field }
    return field
  }
  const fake = {
    object: (shape) => ({ dict: shape }),
    boolean: () => node(),
    string: () => node(),
    number: () => node(),
    array: () => node(),
    dict: () => node(),
    const: () => node(),
    union: () => node(),
  }
  const Config = buildConfig(fake)
  assert.ok(Object.keys(Config.dict).length > 30)
  for (const field of Object.values(Config.dict)) assert.equal(field.meta.volatile, undefined)
})
