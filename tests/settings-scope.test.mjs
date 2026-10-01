// 记忆核心 · settings-scope 单元测试（不联网、不依赖宿主）：
// 旧宿主（settings.register）/ 新宿主（SettingsForms.mutate）/ 无写入口三种形态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSettingsScope } from '../lib/settings-scope.js'

const schema = { dict: { autoCapture: {}, captureDebug: {} } }

test('legacy host: registers a scope and reads through it', () => {
  const calls = []
  let current = { autoCapture: false }
  const settings = {
    register: (ns, sc, opts) => {
      calls.push({ ns, sc, opts })
      return {
        get: () => ({ ...current, ...opts.base }),
        watch: (cb) => { cb(); return () => {} },
        describe: () => [{ namespace: ns, revision: 3 }],
      }
    },
  }
  const scope = resolveSettingsScope(settings, 'memory-eternal', schema, { auditMode: 'none' })
  assert.equal(scope.mode, 'scope')
  assert.equal(scope.get().auditMode, 'none')
  assert.equal(scope.describe()[0].revision, 3)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ns, 'memory-eternal')
  // 旧宿主没有 entry-mode 的 update（写路径走注册出去的 scope）
  assert.equal(typeof scope.update, 'undefined')
})

test('new host: reads the live row config, falls back to the boot config', () => {
  let live
  const scope = resolveSettingsScope({ mutate: async () => {} }, 'memory-eternal', schema, { autoCapture: true }, () => live)
  assert.equal(scope.mode, 'entry')
  assert.equal(scope.get().autoCapture, true)
  live = { autoCapture: false, captureDebug: true }
  assert.equal(scope.get().captureDebug, true)
  // live 读取抛错时退回启动入参
  const throwing = resolveSettingsScope({}, 'memory-eternal', schema, { auditMode: 'none' }, () => { throw new Error('boom') })
  assert.equal(throwing.get().auditMode, 'none')
  // watch 是空退订函数，不是 undefined
  assert.equal(typeof scope.watch(() => {}), 'function')
})

test('new host: update() translates a patch into namespace path ops', async () => {
  const seen = []
  const scope = resolveSettingsScope(
    { mutate: async (ns, ops, revision) => { seen.push({ ns, ops, revision }) } },
    'memory-eternal', schema, {}, undefined,
  )
  assert.equal(typeof scope.update, 'function')
  await scope.update({ captureDebug: true, captureMinChars: 200, auditMode: 'none' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].ns, 'memory-eternal')
  assert.deepEqual(seen[0].ops, [
    { op: 'set', path: ['captureDebug'], value: true },
    { op: 'set', path: ['captureMinChars'], value: 200 },
    { op: 'set', path: ['auditMode'], value: 'none' },
  ])
  // 不传 expectedRevision：调用方拿不到宿主 revision，传 0 只会被判冲突
  assert.equal(seen[0].revision, undefined)
  // 空 patch 不产生任何写入
  await scope.update({})
  await scope.update(undefined)
  assert.equal(seen.length, 1)
})

test('new host: a host-side conflict surfaces as SETTINGS_CONFLICT', async () => {
  const scope = resolveSettingsScope(
    { mutate: async () => { const e = new Error('revision conflict'); e.code = 'SETTINGS_CONFLICT'; throw e } },
    'memory-eternal', schema, {}, undefined,
  )
  await assert.rejects(() => scope.update({ autoCapture: false }), (e) => e.code === 'SETTINGS_CONFLICT')
  // 其它错误原样抛出，交由上层回 500 并带上宿主原文
  const plain = resolveSettingsScope(
    { mutate: async () => { throw new Error('disk full') } },
    'memory-eternal', schema, {}, undefined,
  )
  await assert.rejects(() => plain.update({ autoCapture: false }), /disk full/)
})

test('no settings service: no update, so callers keep the honest 501', () => {
  for (const settings of [undefined, null, {}, 'nope', { mutate: 'not-a-function' }]) {
    const scope = resolveSettingsScope(settings, 'memory-eternal', schema, { auditMode: 'none' })
    assert.equal(scope.mode, 'entry')
    assert.equal(typeof scope.update, 'undefined', `settings=${JSON.stringify(settings)} 不该暴露写入口`)
    assert.equal(scope.get().auditMode, 'none')
  }
})
