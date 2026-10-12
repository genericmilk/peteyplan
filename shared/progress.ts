/** Card work kinds and the progress stages shown as lighting pills. */

export const CARD_KINDS = [
  {
    id: 'development',
    label: 'Development task',
    stages: [
      { id: 'todo', label: 'Todo' },
      { id: 'building', label: 'Building' },
      { id: 'review', label: 'Review' },
      { id: 'deploy', label: 'Deploy' },
      { id: 'qa', label: 'QA' },
      { id: 'done', label: 'Done' },
    ],
  },
  {
    id: 'chore',
    label: 'Chore',
    stages: [
      { id: 'todo', label: 'Todo' },
      { id: 'doing', label: 'Doing' },
      { id: 'done', label: 'Done' },
    ],
  },
  {
    id: 'managing',
    label: 'Managing someone',
    stages: [
      { id: 'todo', label: 'Todo' },
      { id: 'waiting', label: 'Waiting' },
      { id: 'followup', label: 'Follow-up' },
      { id: 'done', label: 'Done' },
    ],
  },
] as const

export type KindId = (typeof CARD_KINDS)[number]['id']
export type ProgressId = (typeof CARD_KINDS)[number]['stages'][number]['id']

export const DEFAULT_KIND: KindId = 'development'
export const DEFAULT_PROGRESS: ProgressId = 'todo'

/** Days a Done card stays on the board before soft-archiving. */
export const ARCHIVE_AFTER_DAYS = 5

export const KIND_IDS: readonly KindId[] = CARD_KINDS.map((k) => k.id)

/** Flat list of every stage id across kinds (for loose validation). */
export const PROGRESS_IDS: readonly ProgressId[] = Array.from(
  new Set(CARD_KINDS.flatMap((k) => k.stages.map((s) => s.id)))
) as ProgressId[]

/** @deprecated Prefer stagesForKind — kept for call sites that assume development. */
export const PROGRESS_STAGES = CARD_KINDS[0].stages

export function isKindId(value: string): value is KindId {
  return (KIND_IDS as readonly string[]).includes(value)
}

export function normalizeKind(input: unknown): KindId {
  if (typeof input !== 'string') return DEFAULT_KIND
  const value = input.trim().toLowerCase()
  return isKindId(value) ? value : DEFAULT_KIND
}

export function kindDef(kind: KindId = DEFAULT_KIND) {
  return CARD_KINDS.find((k) => k.id === kind) ?? CARD_KINDS[0]
}

export function stagesForKind(kind: KindId = DEFAULT_KIND) {
  return kindDef(kind).stages
}

export function isProgressId(value: string): value is ProgressId {
  return (PROGRESS_IDS as readonly string[]).includes(value)
}

export function isProgressForKind(value: string, kind: KindId): boolean {
  return stagesForKind(kind).some((s) => s.id === value)
}

/**
 * Coerce unknown input to a valid progress id for the given kind.
 * Falls back to Todo when missing/invalid for that kind.
 */
export function normalizeProgress(input: unknown, kind: KindId = DEFAULT_KIND): ProgressId {
  const stages = stagesForKind(kind)
  if (typeof input !== 'string') return stages[0].id
  const value = input.trim().toLowerCase()
  return stages.some((s) => s.id === value) ? (value as ProgressId) : stages[0].id
}

export function progressIndex(id: string, kind: KindId = DEFAULT_KIND): number {
  const index = stagesForKind(kind).findIndex((s) => s.id === id)
  return index >= 0 ? index : 0
}

/** When switching kind, keep the stage if shared; otherwise reset to Todo. */
export function progressForKindChange(
  progress: unknown,
  fromKind: KindId,
  toKind: KindId
): ProgressId {
  if (fromKind === toKind) return normalizeProgress(progress, toKind)
  const current = normalizeProgress(progress, fromKind)
  if (isProgressForKind(current, toKind)) return current
  return stagesForKind(toKind)[0].id
}
