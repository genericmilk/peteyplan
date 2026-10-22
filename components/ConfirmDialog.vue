<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { PhWarning } from '@phosphor-icons/vue'
import { confirmState, settleConfirm } from '~/composables/useModal'

const dialogEl = ref<HTMLDialogElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const current = computed(() => confirmState.queue[0] ?? null)
let downOutside = false

watch(current, async (request, previous) => {
  if (!request) {
    if (dialogEl.value?.open) dialogEl.value.close()
    return
  }
  if (request === previous) return
  await nextTick()
  // showModal() again on an open dialog throws; re-opening moves it to the top layer.
  if (dialogEl.value?.open) dialogEl.value.close()
  dialogEl.value?.showModal()
  // Destructive actions focus Cancel so Enter doesn't delete by accident.
  ;(request.tone === 'danger' ? cancelButton : confirmButton).value?.focus()
})

function answer(ok: boolean) {
  settleConfirm(ok)
}

function isOutside(event: MouseEvent): boolean {
  const el = dialogEl.value
  if (!el || event.target !== el) return false
  const r = el.getBoundingClientRect()
  return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom
}

function onClick(event: MouseEvent) {
  if (downOutside && isOutside(event)) answer(false)
  downOutside = false
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="confirm-dialog"
    role="alertdialog"
    aria-labelledby="confirm-dialog-title"
    :aria-describedby="current?.message ? 'confirm-dialog-message' : undefined"
    @cancel.prevent="answer(false)"
    @pointerdown="downOutside = isOutside($event)"
    @click="onClick"
  >
    <form v-if="current" method="dialog" class="dialog-form" @submit.prevent="answer(true)">
      <div class="confirm-dialog-body">
        <span v-if="current.tone === 'danger'" class="confirm-dialog-icon" aria-hidden="true"><PhWarning :size="20" weight="bold" /></span>
        <div>
          <h2 id="confirm-dialog-title">{{ current.title }}</h2>
          <p v-if="current.message" id="confirm-dialog-message" class="confirm-dialog-message">{{ current.message }}</p>
        </div>
      </div>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button ref="cancelButton" type="button" class="btn" @click="answer(false)">{{ current.cancelLabel }}</button>
        <button
          ref="confirmButton"
          type="submit"
          class="btn"
          :class="current.tone === 'danger' ? 'btn-danger btn-danger-solid' : 'btn-primary'"
        >{{ current.confirmLabel }}</button>
      </div>
    </form>
  </dialog>
</template>
