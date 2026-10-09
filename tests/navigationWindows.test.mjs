import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { ref, watch, effectScope } from 'vue'

test('导航菜单内部点击保留，非功能区域和 Escape 收起，卸载移除监听', () => {
  const source = fs.readFileSync(new URL('../src/components/MainNavigation.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup>')[1].split('</script>')[0].replace(/^import\b[^\n]*\r?\n/gm, '')
  const listeners = new Map()
  let mount, unmount
  const context = vm.createContext({ ref, watch, defineProps: () => ({ route: '/' }),
    onMounted: callback => { mount = callback }, onBeforeUnmount: callback => { unmount = callback },
    document: { addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name) } })
  const scope = effectScope()
  scope.run(() => vm.runInContext(script, context))
  mount()
  vm.runInContext("opened.value = 'monitoring'", context)
  listeners.get('click')({ target: { closest: () => ({}) } })
  assert.equal(vm.runInContext('opened.value', context), 'monitoring')
  listeners.get('click')({ target: { closest: () => null } })
  assert.equal(vm.runInContext('opened.value', context), '')
  vm.runInContext("opened.value = 'planning'", context)
  listeners.get('keydown')({ key: 'Escape' })
  assert.equal(vm.runInContext('opened.value', context), '')
  unmount()
  scope.stop()
  assert.equal(listeners.size, 0)
})
