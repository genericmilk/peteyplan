/**
 * Card work kinds and the progress stages shown as lighting pills.
 *
 * Kinds are user-editable (stored in the work_types table). Every kind runs
 * from a fixed `todo` stage to a fixed `done` stage, so completion and
 * auto-archive keep working; only the stages in between are customisable.
 */

export type KindId = string
export type ProgressId = string

export interface StageDef { id: ProgressId; label: string }
export interface KindDef { id: KindId; label: string; stages: StageDef[] }

export const DEFAULT_PROGRESS: ProgressId = 'todo'
export const DONE_PROGRESS: ProgressId = 'done'
export const FIRST_STAGE: StageDef = { id: DEFAULT_PROGRESS, label: 'Todo' }
export const LAST_STAGE: StageDef = { id: DONE_PROGRESS, label: 'Done' }

export const KIND_LABEL_MAX_LENGTH = 40
export const STAGE_LABEL_MAX_LENGTH = 24
export const KINDS_MAX = 20
/** Custom stages between Todo and Done. */
export const STAGES_MAX = 8

/** Seeded on first start; also the fallback until stored kinds are loaded. */
export const DEFAULT_KINDS: KindDef[] = [
  {
    id: 'development',
    label: 'Development task',
    stages: [
      FIRST_STAGE,
      { id: 'building', label: 'Building' },
      { id: 'review', label: 'Review' },
      { id: 'deploy', label: 'Deploy' },
      { id: 'qa', label: 'QA' },
      LAST_STAGE,
    ],
  },
  {
    id: 'chore',
    label: 'Chore',
    stages: [FIRST_STAGE, { id: 'doing', label: 'Doing' }, LAST_STAGE],
  },
  {
    id: 'managing',
    label: 'Managing someone',
    stages: [
      FIRST_STAGE,
      { id: 'waiting', label: 'Waiting' },
      { id: 'followup', label: 'Follow-up' },
      LAST_STAGE,
    ],
  },
]

/** Days a Done card stays on the board before soft-archiving. */
export const ARCHIVE_AFTER_DAYS = 5

let readKinds: () => KindDef[] = () => DEFAULT_KINDS

/**
 * Point the helpers below at the live kind list. The client passes a getter
 * over a reactive ref, so templates re-render when kinds change.
 */
export function useCardKinds(getter: () => KindDef[]) {
  readKinds = getter
}

export function cardKinds(): KindDef[] {
  const kinds = readKinds()
  return kinds.length ? kinds : DEFAULT_KINDS
}

/** The first kind in the list is the default for new cards. */
export function defaultKind(): KindId {
  return cardKinds()[0].id
}

export function isKindId(value: string): boolean {
  return cardKinds().some((k) => k.id === value)
}

/** Accepts a kind id or, case-insensitively, its id or label (handy for MCP/API callers). */
export function normalizeKind(input: unknown): KindId {
  if (typeof input !== 'string') return defaultKind()
  const value = input.trim()
  if (isKindId(value)) return value
  const loose = value.toLowerCase()
  return cardKinds().find((k) => k.id.toLowerCase() === loose || k.label.toLowerCase() === loose)?.id ?? defaultKind()
}

export function kindDef(kind: KindId = defaultKind()): KindDef {
  const kinds = cardKinds()
  return kinds.find((k) => k.id === kind) ?? kinds[0]
}

export function stagesForKind(kind: KindId = defaultKind()): StageDef[] {
  return kindDef(kind).stages
}

export function isProgressForKind(value: string, kind: KindId): boolean {
  return stagesForKind(kind).some((s) => s.id === value)
}

/**
 * Coerce unknown input to a valid progress id for the given kind.
 * Falls back to Todo when missing/invalid for that kind.
 */
export function normalizeProgress(input: unknown, kind: KindId = defaultKind()): ProgressId {
  const stages = stagesForKind(kind)
  if (typeof input !== 'string') return stages[0].id
  const value = input.trim()
  const loose = value.toLowerCase()
  return (stages.find((s) => s.id === value) ?? stages.find((s) => s.id.toLowerCase() === loose || s.label.toLowerCase() === loose) ?? stages[0]).id
}

export function progressIndex(id: string, kind: KindId = defaultKind()): number {
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

function cleanLabel(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function slugId(label: string, taken: Set<string>, fallback: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || fallback
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/**
 * Validate an edited kind list. Keeps known ids so cards stay attached,
 * mints ids for new kinds/stages, and pins Todo first and Done last.
 * Throws with a user-facing message when the list is unusable.
 */
export function normalizeKinds(input: unknown): KindDef[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Keep at least one work type')
  if (input.length > KINDS_MAX) throw new Error(`Up to ${KINDS_MAX} work types are supported`)
  const kindIds = new Set<string>()
  const kinds: KindDef[] = []
  for (const raw of input) {
    const label = cleanLabel(raw?.label, KIND_LABEL_MAX_LENGTH)
    if (!label) throw new Error('Every work type needs a name')
    if (kinds.some((k) => k.label.toLowerCase() === label.toLowerCase())) {
      throw new Error(`There are two work types called "${label}"`)
    }
    const wantedId = typeof raw?.id === 'string' ? raw.id.trim().slice(0, 40) : ''
    const id = wantedId && !kindIds.has(wantedId) ? (kindIds.add(wantedId), wantedId) : slugId(label, kindIds, 'type')

    const stageIds = new Set<string>([DEFAULT_PROGRESS, DONE_PROGRESS])
    const middle: StageDef[] = []
    const rawStages: unknown[] = Array.isArray(raw?.stages) ? raw.stages : []
    for (const stage of rawStages as { id?: unknown; label?: unknown }[]) {
      const stageId = typeof stage?.id === 'string' ? stage.id.trim().slice(0, 40) : ''
      if (stageId === DEFAULT_PROGRESS || stageId === DONE_PROGRESS) continue
      const stageLabel = cleanLabel(stage?.label, STAGE_LABEL_MAX_LENGTH)
      if (!stageLabel) continue
      if (middle.length >= STAGES_MAX) throw new Error(`"${label}" can have up to ${STAGES_MAX} stages between Todo and Done`)
      middle.push({
        id: stageId && !stageIds.has(stageId) ? (stageIds.add(stageId), stageId) : slugId(stageLabel, stageIds, 'stage'),
        label: stageLabel,
      })
    }
    kinds.push({ id, label, stages: [FIRST_STAGE, ...middle, LAST_STAGE] })
  }
  return kinds
}
