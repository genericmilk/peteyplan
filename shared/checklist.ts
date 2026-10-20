/** Card checklists: small to-do lists stored on a card. */

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export const CHECKLIST_MAX_ITEMS = 100
export const CHECKLIST_ITEM_MAX_LENGTH = 200

function itemId(): string {
  return `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Coerce untrusted input (array or JSON string) to a clean checklist; drops blank items. */
export function normalizeChecklist(input: unknown): ChecklistItem[] {
  let raw = input
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const items: ChecklistItem[] = []
  for (const entry of raw) {
    if (items.length >= CHECKLIST_MAX_ITEMS) break
    const value = typeof entry === 'string' ? { text: entry } : entry
    if (!value || typeof value !== 'object') continue
    const text = typeof value.text === 'string'
      ? value.text.replace(/\s+/g, ' ').trim().slice(0, CHECKLIST_ITEM_MAX_LENGTH)
      : ''
    if (!text) continue
    let id = typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 64) : itemId()
    if (seen.has(id)) id = itemId()
    seen.add(id)
    items.push({ id, text, done: value.done === true })
  }
  return items
}

export function newChecklistItem(text: string): ChecklistItem {
  return { id: itemId(), text, done: false }
}

export function checklistProgress(items: ChecklistItem[] | undefined): { done: number; total: number } {
  const list = items ?? []
  return { done: list.filter((item) => item.done).length, total: list.length }
}
