/** Accept YYYY-MM-DD (or empty). Invalid values become ''. */
export function normalizeDueBy(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ''
  const [y, m, d] = trimmed.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return ''
  }
  return trimmed
}
