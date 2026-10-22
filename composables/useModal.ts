import { reactive, type Directive } from 'vue'

/**
 * Shared modal behaviour for native <dialog> elements, plus an in-app
 * replacement for window.confirm().
 *
 * `v-modal` adds: backdrop click to dismiss, an unsaved-changes guard on every
 * dismiss route (backdrop, Esc, Cancel buttons via `requestDialogClose`), and
 * a resizable size that's remembered per dialog.
 */

/* ── Confirm ───────────────────────────────────────────────────────────────── */

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` styles the confirm button red, for destructive actions */
  tone?: 'primary' | 'danger'
}

interface ConfirmRequest extends Required<Omit<ConfirmOptions, 'message'>> {
  message: string
  resolve: (ok: boolean) => void
}

export const confirmState = reactive<{ queue: ConfirmRequest[] }>({ queue: [] })

/** Ask a yes/no question in a styled dialog. Resolves true when confirmed. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.queue.push({
      title: options.title,
      message: options.message ?? '',
      confirmLabel: options.confirmLabel ?? 'OK',
      cancelLabel: options.cancelLabel ?? 'Cancel',
      tone: options.tone ?? 'primary',
      resolve,
    })
  })
}

/** Answer the confirm on screen. */
export function settleConfirm(ok: boolean) {
  confirmState.queue.shift()?.resolve(ok)
}

/* ── v-modal ───────────────────────────────────────────────────────────────── */

export interface ModalOptions {
  /** Key for the remembered size; omit to make the dialog non-resizable */
  sizeKey?: string
  /** True while the dialog holds edits that would be lost */
  isDirty?: () => boolean
  /** False to ignore dismiss requests (e.g. while saving) */
  canDismiss?: () => boolean
}

interface ModalState {
  options: ModalOptions
  downOutside: boolean
  sizeAtDown: { w: number; h: number } | null
  cleanup: () => void
}

const SIZE_PREFIX = 'peteyplan-dialog-size:'
const modals = new WeakMap<HTMLDialogElement, ModalState>()

function readSize(key: string): { w: number; h: number } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_PREFIX + key) || 'null')
    return saved && Number.isFinite(saved.w) && Number.isFinite(saved.h) ? saved : null
  } catch {
    return null
  }
}

function writeSize(key: string, size: { w: number; h: number }) {
  try { localStorage.setItem(SIZE_PREFIX + key, JSON.stringify(size)) } catch { /* private mode */ }
}

/** Apply a remembered size, clamped so it never opens off-screen. */
function applySize(el: HTMLDialogElement, key: string) {
  const size = readSize(key)
  if (!size) return
  el.style.width = `${Math.min(size.w, window.innerWidth - 32)}px`
  el.style.height = `${Math.min(size.h, window.innerHeight - 32)}px`
}

function outside(el: HTMLDialogElement, event: MouseEvent): boolean {
  // Clicks on the dialog's own padding/scrollbar/resize grip land on the
  // element too, so test the point against its box instead of the target.
  if (event.target !== el) return false
  const r = el.getBoundingClientRect()
  return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom
}

/**
 * Close a v-modal dialog the way a dismiss should: respects canDismiss and asks
 * before throwing away unsaved changes. Returns whether it closed.
 */
export async function requestDialogClose(el: HTMLDialogElement | null | undefined): Promise<boolean> {
  if (!el?.open) return false
  const state = modals.get(el)
  if (state?.options.canDismiss && !state.options.canDismiss()) return false
  if (state?.options.isDirty?.()) {
    const discard = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: 'Your edits in this dialog haven\'t been saved.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    })
    if (!discard) return false
  }
  el.close()
  return true
}

export const vModal: Directive<HTMLDialogElement, ModalOptions | undefined> = {
  mounted(el, binding) {
    const state: ModalState = { options: binding.value ?? {}, downOutside: false, sizeAtDown: null, cleanup: () => {} }
    modals.set(el, state)
    if (state.options.sizeKey) el.classList.add('dialog-resizable')

    const onPointerDown = (event: PointerEvent) => {
      state.downOutside = outside(el, event)
      state.sizeAtDown = state.options.sizeKey ? { w: el.offsetWidth, h: el.offsetHeight } : null
    }
    const onPointerUp = () => {
      const key = state.options.sizeKey
      const before = state.sizeAtDown
      state.sizeAtDown = null
      if (!key || !before) return
      // Only a drag of the resize grip changes the box size between down and up.
      const after = { w: el.offsetWidth, h: el.offsetHeight }
      if (after.w !== before.w || after.h !== before.h) writeSize(key, after)
    }
    const onClick = (event: MouseEvent) => {
      // Both ends of the click outside, so a text selection that ends on the backdrop doesn't close it.
      if (state.downOutside && outside(el, event)) void requestDialogClose(el)
      state.downOutside = false
    }
    const onCancel = (event: Event) => {
      event.preventDefault()
      void requestDialogClose(el)
    }
    // Restore the remembered size each time it opens.
    const observer = new MutationObserver(() => {
      if (el.open && state.options.sizeKey) applySize(el, state.options.sizeKey)
    })
    observer.observe(el, { attributes: true, attributeFilter: ['open'] })

    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    el.addEventListener('click', onClick)
    el.addEventListener('cancel', onCancel)
    state.cleanup = () => {
      observer.disconnect()
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('click', onClick)
      el.removeEventListener('cancel', onCancel)
    }
  },
  updated(el, binding) {
    const state = modals.get(el)
    if (state) state.options = binding.value ?? {}
  },
  unmounted(el) {
    modals.get(el)?.cleanup()
    modals.delete(el)
  },
}

/** Forget every remembered dialog size (Settings → Appearance). */
export function resetDialogSizes() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(SIZE_PREFIX)) localStorage.removeItem(key)
  } catch { /* private mode */ }
}
