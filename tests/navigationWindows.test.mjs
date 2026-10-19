import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { ref, watch, computed, effectScope } from 'vue'

test('操作说明内部点击保留，外部与 Escape 收起，卸载移除监听', () => {
  const source = fs.readFileSync(new URL('../src/components/MainNavigation.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup>')[1].split('</script>')[0].replace(/^import\b[^\n]*\r?\n/gm, '')
  const listeners = new Map()
  let mount, unmount
  const context = vm.createContext({ ref, watch, computed, defineProps: () => ({ route: '/' }), defineEmits: () => () => {},
    onMounted: callback => { mount = callback }, onBeforeUnmount: callback => { unmount = callback },
    document: { addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name) } })
  const scope = effectScope()
  scope.run(() => vm.runInContext(script, context))
  mount()
  vm.runInContext('menuOpen.value = true', context)
  listeners.get('click')({ target: { closest: () => ({}) } })
  assert.equal(vm.runInContext('menuOpen.value', context), true)
  listeners.get('click')({ target: { closest: () => null } })
  assert.equal(vm.runInContext('menuOpen.value', context), false)
  vm.runInContext('menuOpen.value = true', context)
  listeners.get('keydown')({ key: 'Escape' })
  assert.equal(vm.runInContext('menuOpen.value', context), false)
  unmount()
  scope.stop()
  assert.equal(listeners.size, 0)
})
