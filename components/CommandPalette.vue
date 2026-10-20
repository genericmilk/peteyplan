<script setup lang="ts">
import { computed, nextTick, ref, watch, type Component } from 'vue'
import { PhMagnifyingGlass } from '@phosphor-icons/vue'
import { rankEntries, type PaletteEntry } from '~/shared/palette'

export interface PaletteItem extends PaletteEntry {
  subtitle?: string
  /** Short text on the right, e.g. a card ref or shortcut */
  hint?: string
  icon?: Component
  emoji?: string
  /** Board colour dot, for board and card rows */
  color?: string
  muted?: boolean
  run: () => void | Promise<void>
}

const props = defineProps<{ items: PaletteItem[]; loading?: boolean }>()
const open = defineModel<boolean>('open', { required: true })
const query = defineModel<string>('query', { required: true })

const dialogEl = ref<HTMLDialogElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const active = ref(0)
// Only one palette exists; a fixed id avoids SSR/client useId() drift.
const listId = 'command-palette-results'

const results = computed(() => rankEntries(props.items, query.value))
const groups = computed(() => {
  const out: { name: string; items: { item: PaletteItem; index: number }[] }[] = []
  results.value.forEach((item, index) => {
    const last = out[out.length - 1]
    if (last?.name === item.group) last.items.push({ item, index })
    else out.push({ name: item.group, items: [{ item, index }] })
  })
  return out
})

watch(results, () => { active.value = 0 })

watch(open, async (isOpen) => {
  if (!isOpen) {
    if (dialogEl.value?.open) dialogEl.value.close()
    return
  }
  active.value = 0
  await nextTick()
  if (!dialogEl.value?.open) dialogEl.value?.showModal()
  inputEl.value?.focus()
  inputEl.value?.select()
})

function optionId(index: number) {
  return `${listId}-${index}`
}

function move(delta: number) {
  const count = results.value.length
  if (!count) return
  active.value = (active.value + delta + count) % count
  nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView({ block: 'nearest' }))
}

async function choose(index = active.value) {
  const item = results.value[index]
  if (!item) return
  open.value = false
  await item.run()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) { event.preventDefault(); move(1) }
  else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) { event.preventDefault(); move(-1) }
  else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); choose() }
}

function onDialogClick(event: MouseEvent) {
  // Clicks on the backdrop land on the dialog element itself.
  if (event.target === dialogEl.value) open.value = false
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="command-palette"
    aria-label="Command palette"
    @close="open = false"
    @click="onDialogClick"
  >
    <div class="palette-search">
      <PhMagnifyingGlass :size="17" aria-hidden="true" />
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="results.length > 0"
        :aria-controls="listId"
        :aria-activedescendant="results.length ? optionId(active) : undefined"
        placeholder="Search cards, boards, columns and actions…"
        autocomplete="off"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <kbd aria-hidden="true">esc</kbd>
    </div>
    <div :id="listId" class="palette-results" role="listbox" aria-label="Results">
      <template v-for="group in groups" :key="group.name">
        <div class="palette-group" role="presentation">{{ group.name }}</div>
        <div
          v-for="{ item, index } in group.items"
          :id="optionId(index)"
          :key="item.id"
          class="palette-item"
          :class="{ active: index === active, muted: item.muted }"
          role="option"
          :aria-selected="index === active"
          @mousemove="active = index"
          @click="choose(index)"
        >
          <span class="palette-item-icon" aria-hidden="true">
            <span v-if="item.emoji">{{ item.emoji }}</span>
            <component :is="item.icon" v-else-if="item.icon" :size="16" />
            <span v-else-if="item.color" class="palette-dot" :style="{ background: item.color }"></span>
          </span>
          <span class="palette-item-text">
            <span class="palette-item-title">{{ item.title }}</span>
            <span v-if="item.subtitle" class="palette-item-subtitle">{{ item.subtitle }}</span>
          </span>
          <span v-if="item.hint" class="palette-item-hint">{{ item.hint }}</span>
        </div>
      </template>
      <p v-if="!results.length" class="palette-empty">
        {{ loading ? 'Loading…' : query.trim() ? `Nothing matches “${query.trim()}”` : 'Start typing to search' }}
      </p>
    </div>
    <div class="palette-footer" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
      <span><kbd>↵</kbd> to open</span>
    </div>
  </dialog>
</template>
