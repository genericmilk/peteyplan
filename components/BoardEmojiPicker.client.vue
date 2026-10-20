<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import EmojiPicker, { type EmojiSelection } from 'vue3-emoji-picker'
import 'vue3-emoji-picker/css'

defineProps<{ label: string; disabled?: boolean }>()
const model = defineModel<string>({ required: true })
const open = ref(false)
const panel = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const panelId = useId()

async function toggle() {
  if (open.value) { close(); return }
  open.value = true
  await nextTick()
  panel.value?.showPopover()
  positionPanel()
  panel.value?.querySelector<HTMLInputElement>('input')?.focus()
}

function close(restoreFocus = true) {
  panel.value?.hidePopover()
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

function positionPanel() {
  if (!open.value || !panel.value || !trigger.value) return
  const rect = trigger.value.getBoundingClientRect()
  const height = panel.value.offsetHeight
  const below = window.innerHeight - rect.bottom - 8
  const top = below >= height || below >= rect.top - 8
    ? Math.min(rect.bottom + 6, window.innerHeight - height - 8)
    : Math.max(8, rect.top - height - 6)
  panel.value.style.top = `${Math.max(8, top)}px`
  panel.value.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.value.offsetWidth - 8))}px`
}

function onBlur(event: FocusEvent) {
  const target = event.relatedTarget
  if (!(target instanceof Node) || (!panel.value?.contains(target) && !trigger.value?.contains(target))) {
    close(false)
  }
}

function onToggle() {
  if (!panel.value?.matches(':popover-open')) open.value = false
}

function selectEmoji(emoji: EmojiSelection) {
  model.value = emoji.i
  close()
}

function onEnter(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement) event.preventDefault()
}

onMounted(() => {
  window.addEventListener('resize', positionPanel)
  document.addEventListener('scroll', positionPanel, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionPanel)
  document.removeEventListener('scroll', positionPanel, true)
})
</script>

<template>
  <div class="board-emoji-field">
    <div class="board-emoji-control">
      <span>Emoji</span>
      <button
        ref="trigger"
        type="button"
        class="btn board-emoji-trigger"
        :aria-label="label"
        :aria-expanded="open"
        :aria-controls="panelId"
        :disabled="disabled"
        @click="toggle"
        @focusout="onBlur"
      >{{ model }}</button>
    </div>
    <div
      :id="panelId"
      ref="panel"
      popover="auto"
      class="board-emoji-panel"
      role="region"
      :aria-label="label + ' picker'"
      @keydown.esc.stop.prevent="close()"
      @keydown.enter="onEnter"
      @focusout="onBlur"
      @toggle="onToggle"
    >
      <EmojiPicker v-if="open" :native="true" :hide-search="false" theme="dark" @select="selectEmoji" />
    </div>
  </div>
</template>
