declare module 'vue3-emoji-picker' {
  import type { DefineComponent } from 'vue'

  export interface EmojiSelection {
    i: string
    n: string[]
    r: string
    t: string
    u: string
  }

  const EmojiPicker: DefineComponent<{
    native?: boolean
    hideSearch?: boolean
    theme?: 'light' | 'dark' | 'auto'
    onSelect?: (emoji: EmojiSelection) => void
  }>
  export default EmojiPicker
}
