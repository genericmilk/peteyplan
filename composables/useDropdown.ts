import type { Directive } from 'vue'

/**
 * `v-dismiss="close"` on a dropdown menu closes it when focus leaves it, on
 * Escape, and when the window loses focus. Opening moves focus into the menu
 * (unless something inside already took it), and Escape hands focus back to
 * whatever opened it.
 */

interface DismissState {
  close: () => void
  returnTo: HTMLElement | null
  pressedInside: boolean
  cleanup: () => void
}

const states = new WeakMap<HTMLElement, DismissState>()

const FOCUSABLE = 'input:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export const vDismiss: Directive<HTMLElement, () => void> = {
  mounted(el, binding) {
    const active = document.activeElement
    const state: DismissState = {
      close: binding.value,
      returnTo: active instanceof HTMLElement && active !== document.body ? active : null,
      pressedInside: false,
      cleanup: () => {},
    }
    states.set(el, state)

    if (!el.contains(document.activeElement)) {
      if (!el.hasAttribute('tabindex')) el.tabIndex = -1
      ;(el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus({ preventScroll: true })
    }

    // Safari doesn't focus buttons on click, so a press inside would read as a blur.
    const onPointerDown = () => { state.pressedInside = true }
    const onPointerUp = () => { setTimeout(() => { state.pressedInside = false }) }
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null
      if (state.pressedInside || (next && el.contains(next))) return
      state.close()
    }
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      state.close()
      state.returnTo?.focus({ preventScroll: true })
    }
    const onWindowBlur = () => state.close()

    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    el.addEventListener('focusout', onFocusOut)
    el.addEventListener('keydown', onKeydown)
    window.addEventListener('blur', onWindowBlur)
    state.cleanup = () => {
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('focusout', onFocusOut)
      el.removeEventListener('keydown', onKeydown)
      window.removeEventListener('blur', onWindowBlur)
    }
  },
  updated(el, binding) {
    const state = states.get(el)
    if (state) state.close = binding.value
  },
  unmounted(el) {
    states.get(el)?.cleanup()
    states.delete(el)
  },
}

/** Fixed position for a menu under `anchor`, lined up with its left or right edge. */
export function menuPosition(anchor: Element, align: 'left' | 'right', width = 240) {
  const rect = anchor.getBoundingClientRect()
  const top = rect.bottom + 6
  return align === 'left'
    ? { top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) }
    : { top, right: Math.max(8, window.innerWidth - rect.right) }
}
