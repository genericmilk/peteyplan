<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
  PhArrowCounterClockwise,
  PhCaretDown,
  PhCaretRight,
  PhCheck,
  PhGitPullRequest,
  PhGlobeSimple,
  PhPencilSimple,
  PhPlus,
  PhX,
} from '@phosphor-icons/vue'
import { kindDef, normalizeKind, normalizeProgress } from '~/shared/progress'
import { requestDialogClose, vModal } from '~/composables/useModal'

export interface ReleaseCardView {
  id: string
  ref: string
  title: string
  columnId?: string
  boardId: string
  kind?: string
  progress?: string
  archivedAt?: string | null
  pullRequests?: string[]
}

export interface ReleaseView {
  id: string
  title: string
  /** Pinned board, or null when shared by every board */
  boardId: string | null
  doneAt: string | null
  weekStart: string
  preprodSchedule: string
  prodSchedule: string
  preprodKey: string
  prodKey: string
  cards: ReleaseCardView[]
}

interface BoardChip { id: string; name: string; emoji: string }

const props = defineProps<{
  releases: ReleaseView[]
  boards: BoardChip[]
  activeBoardId: string
  dropTarget: string | null
  dragging: boolean
  jiraUrl: (key: string) => string
  preprodHint: string
  prodHint: string
}>()

const emit = defineEmits<{
  create: [boardScope: string | null]
  edit: [releaseId: string]
  setDone: [releaseId: string, done: boolean, completeCards: boolean]
  openCard: [card: ReleaseCardView]
  removeCard: [releaseId: string, cardId: string]
  dragover: [event: DragEvent, releaseId: string]
  dragleave: [event: DragEvent]
  drop: [event: DragEvent, releaseId: string]
}>()

const tab = ref<'open' | 'done'>('open')
const newMenuOpen = ref(false)
const expanded = ref(new Set<string>())

const openReleases = computed(() => props.releases.filter((rel) => !rel.doneAt))
const doneReleases = computed(() => props.releases.filter((rel) => rel.doneAt))
const activeBoard = computed(() => props.boards.find((board) => board.id === props.activeBoardId))

function boardOf(id: string | null) {
  return id ? props.boards.find((board) => board.id === id) : undefined
}

function scopeLabel(rel: ReleaseView): string {
  const board = boardOf(rel.boardId)
  return board ? `${board.emoji} ${board.name}` : 'All boards'
}

function cardFinished(card: ReleaseCardView): boolean {
  return !!card.archivedAt || normalizeProgress(card.progress, normalizeKind(card.kind)) === 'done'
}

function finishedCount(rel: ReleaseView): number {
  return rel.cards.filter(cardFinished).length
}

function stageLabel(card: ReleaseCardView): string {
  if (card.archivedAt) return 'Archived'
  const kind = normalizeKind(card.kind)
  const progress = normalizeProgress(card.progress, kind)
  return kindDef(kind).stages.find((stage) => stage.id === progress)?.label ?? ''
}

function parseWeek(weekStart: string, offsetDays: number, hour = 0): Date | null {
  const [y, m, d] = weekStart.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d + offsetDays, hour)
}

function formatWeekDay(weekStart: string, offsetDays: number): string {
  const date = parseWeek(weekStart, offsetDays)
  return date
    ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : weekStart
}

/** Prod go-live (Tuesday 17:00) has passed but the release is still open. */
function pastDue(rel: ReleaseView): boolean {
  const live = parseWeek(rel.weekStart, 1, 17)
  return !rel.doneAt && !!live && live.getTime() < Date.now()
}

function formatDoneAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function toggleExpanded(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

function create(scope: string | null) {
  newMenuOpen.value = false
  tab.value = 'open'
  emit('create', scope)
}

/* ── Mark done confirm ─────────────────────────────────────────────────────── */

const confirmEl = ref<HTMLDialogElement | null>(null)
const confirmId = ref<string | null>(null)
const confirmCompleteCards = ref(false)
const confirmRelease = computed(() => props.releases.find((rel) => rel.id === confirmId.value))
const confirmUnfinished = computed(() => {
  const rel = confirmRelease.value
  return rel ? rel.cards.length - finishedCount(rel) : 0
})

function confirmDone(releaseId: string) {
  confirmId.value = releaseId
  confirmCompleteCards.value = false
  nextTick(() => confirmEl.value?.showModal())
}

function submitDone() {
  if (confirmId.value) emit('setDone', confirmId.value, true, confirmUnfinished.value > 0 && confirmCompleteCards.value)
  confirmEl.value?.close()
}

function onFolderDragOver(event: DragEvent, rel: ReleaseView) {
  if (!rel.doneAt) emit('dragover', event, rel.id)
}

defineExpose({ confirmDone, showTab: (next: 'open' | 'done') => { tab.value = next } })
</script>

<template>
  <section id="releases-panel" class="releases-panel" aria-label="Releases">
    <div class="releases-panel-header">
      <div class="releases-heading">
        <div class="releases-title-row">
          <h2>Releases</h2>
          <div class="segmented segmented-sm" role="tablist" aria-label="Release status">
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'open'"
              @click="tab = 'open'"
            >Upcoming<span class="releases-tab-count">{{ openReleases.length }}</span></button>
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'done'"
              @click="tab = 'done'"
            >Done<span class="releases-tab-count">{{ doneReleases.length }}</span></button>
          </div>
        </div>
        <p class="releases-panel-hint">
          <template v-if="tab === 'open'">Drag cards into a folder. Preprod update {{ preprodHint }} · Prod go-live {{ prodHint }}</template>
          <template v-else>Shipped releases, newest first. Reopen one to change its cards.</template>
        </p>
      </div>
      <div class="release-new">
        <button
          class="btn btn-primary"
          type="button"
          :aria-expanded="newMenuOpen"
          aria-haspopup="menu"
          @click="newMenuOpen = !newMenuOpen"
        ><PhPlus :size="15" weight="bold" aria-hidden="true" />New release<PhCaretDown :size="12" weight="bold" aria-hidden="true" /></button>
        <template v-if="newMenuOpen">
          <div class="release-new-backdrop" @click="newMenuOpen = false"></div>
          <div class="column-menu release-new-menu" role="menu" @keydown.esc="newMenuOpen = false">
            <button type="button" role="menuitem" @click="create(null)">
              <PhGlobeSimple :size="15" />
              <span>For all boards<small>Cards from any board can join</small></span>
            </button>
            <button v-if="activeBoard" type="button" role="menuitem" @click="create(activeBoard.id)">
              <span class="release-new-emoji" aria-hidden="true">{{ activeBoard.emoji }}</span>
              <span>Only {{ activeBoard.name }}<small>Just this board's cards</small></span>
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="tab === 'open'" class="releases-row">
      <article
        v-for="rel in openReleases"
        :key="rel.id"
        class="release-folder"
        :class="{ 'drop-target': dropTarget === rel.id, 'release-past-due': pastDue(rel) }"
        @dragover="onFolderDragOver($event, rel)"
        @dragleave="emit('dragleave', $event)"
        @drop="emit('drop', $event, rel.id)"
      >
        <div class="release-folder-header">
          <div class="release-folder-title-row">
            <h3 class="release-folder-title" :title="rel.title">{{ rel.title }}</h3>
            <button
              type="button"
              class="btn-icon"
              title="Mark release done"
              aria-label="Mark release done"
              @click="confirmDone(rel.id)"
            ><PhCheck :size="15" weight="bold" /></button>
            <button
              type="button"
              class="btn-icon"
              title="Edit release"
              aria-label="Edit release"
              @click="emit('edit', rel.id)"
            ><PhPencilSimple :size="15" /></button>
          </div>
          <div class="release-tags">
            <span class="release-scope" :class="{ shared: !rel.boardId }" :title="rel.boardId ? 'Only takes cards from this board' : 'Takes cards from any board'">
              <PhGlobeSimple v-if="!rel.boardId" :size="12" aria-hidden="true" />{{ scopeLabel(rel) }}
            </span>
            <span v-if="pastDue(rel)" class="release-past-due-tag" title="Prod go-live has passed. Mark it done once it's shipped.">Past due</span>
          </div>
          <div class="release-schedule">
            <div class="release-schedule-row">
              <span class="release-env">Preprod</span>
              <span class="release-when">{{ formatWeekDay(rel.weekStart, 0) }} · {{ rel.preprodSchedule }}</span>
              <a
                v-if="rel.preprodKey"
                class="release-ticket"
                :href="jiraUrl(rel.preprodKey)"
                :title="'Open preprod ' + rel.preprodKey"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ rel.preprodKey }}</a>
              <button
                v-else
                type="button"
                class="release-ticket release-ticket-missing"
                @click="emit('edit', rel.id)"
              >Link ticket</button>
            </div>
            <div class="release-schedule-row">
              <span class="release-env release-env-prod">Prod</span>
              <span class="release-when">{{ formatWeekDay(rel.weekStart, 1) }} · {{ rel.prodSchedule }}</span>
              <a
                v-if="rel.prodKey"
                class="release-ticket"
                :href="jiraUrl(rel.prodKey)"
                :title="'Open CM ' + rel.prodKey"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ rel.prodKey }}</a>
              <button
                v-else
                type="button"
                class="release-ticket release-ticket-missing"
                @click="emit('edit', rel.id)"
              >Link CM</button>
            </div>
          </div>
          <div v-if="rel.cards.length" class="release-progress" :title="finishedCount(rel) + ' of ' + rel.cards.length + ' cards done'">
            <span class="checklist-bar" :class="{ 'checklist-bar-complete': finishedCount(rel) === rel.cards.length }" aria-hidden="true">
              <span :style="{ width: (finishedCount(rel) / rel.cards.length) * 100 + '%' }"></span>
            </span>
            <span class="release-progress-count">{{ finishedCount(rel) }}/{{ rel.cards.length }}</span>
          </div>
        </div>
        <ul class="release-cards">
          <li
            v-for="card in rel.cards"
            :key="card.id"
            class="release-card"
            :class="{ finished: cardFinished(card) }"
          >
            <button
              type="button"
              class="release-card-open"
              :title="card.boardId !== activeBoardId ? 'On ' + (boardOf(card.boardId)?.name ?? 'another board') : undefined"
              @click="emit('openCard', card)"
            >
              <PhCheck v-if="cardFinished(card)" class="release-card-check" :size="12" weight="bold" aria-hidden="true" />
              <span v-if="card.boardId !== activeBoardId" class="release-card-board" aria-hidden="true">{{ boardOf(card.boardId)?.emoji }}</span>
              <span v-if="card.ref" class="card-ref">{{ card.ref }}</span>
              <span class="release-card-title">{{ card.title }}</span>
              <span
                v-if="card.pullRequests?.length"
                class="release-card-prs"
                :title="card.pullRequests.length + ' linked pull request' + (card.pullRequests.length === 1 ? '' : 's')"
              ><PhGitPullRequest :size="11" weight="bold" aria-hidden="true" />{{ card.pullRequests.length }}</span>
              <span class="release-card-stage">{{ stageLabel(card) }}</span>
            </button>
            <button
              v-if="!card.archivedAt"
              type="button"
              class="btn-icon release-card-remove"
              title="Remove from release"
              aria-label="Remove from release"
              @click="emit('removeCard', rel.id, card.id)"
            ><PhX :size="14" /></button>
          </li>
          <li v-if="rel.cards.length === 0" class="release-empty">
            {{ dragging ? 'Drop card here' : 'Drop cards here' }}
          </li>
        </ul>
      </article>
      <div v-if="openReleases.length === 0" class="releases-empty-state">
        No upcoming releases. Create one for the next Monday / Tuesday window.
      </div>
    </div>

    <div v-else class="releases-done-list">
      <div v-for="rel in doneReleases" :key="rel.id" class="release-done">
        <div class="release-done-row">
          <button
            type="button"
            class="release-done-toggle"
            :aria-expanded="expanded.has(rel.id)"
            @click="toggleExpanded(rel.id)"
          >
            <PhCaretDown v-if="expanded.has(rel.id)" :size="13" weight="bold" aria-hidden="true" />
            <PhCaretRight v-else :size="13" weight="bold" aria-hidden="true" />
            <span class="release-done-title">{{ rel.title }}</span>
            <span class="release-scope" :class="{ shared: !rel.boardId }">{{ scopeLabel(rel) }}</span>
            <span class="release-done-meta">Done {{ formatDoneAt(rel.doneAt!) }} · {{ rel.cards.length }} card{{ rel.cards.length === 1 ? '' : 's' }}</span>
          </button>
          <button type="button" class="btn" title="Move back to Upcoming" @click="emit('setDone', rel.id, false, false)">
            <PhArrowCounterClockwise :size="14" aria-hidden="true" />Reopen
          </button>
          <button type="button" class="btn-icon" title="Edit release" aria-label="Edit release" @click="emit('edit', rel.id)"><PhPencilSimple :size="15" /></button>
        </div>
        <ul v-if="expanded.has(rel.id)" class="release-cards release-done-cards">
          <li v-for="card in rel.cards" :key="card.id" class="release-card" :class="{ finished: cardFinished(card) }">
            <button type="button" class="release-card-open" @click="emit('openCard', card)">
              <PhCheck v-if="cardFinished(card)" class="release-card-check" :size="12" weight="bold" aria-hidden="true" />
              <span v-if="card.boardId !== activeBoardId" class="release-card-board" aria-hidden="true">{{ boardOf(card.boardId)?.emoji }}</span>
              <span v-if="card.ref" class="card-ref">{{ card.ref }}</span>
              <span class="release-card-title">{{ card.title }}</span>
              <span
                v-if="card.pullRequests?.length"
                class="release-card-prs"
                :title="card.pullRequests.length + ' linked pull request' + (card.pullRequests.length === 1 ? '' : 's')"
              ><PhGitPullRequest :size="11" weight="bold" aria-hidden="true" />{{ card.pullRequests.length }}</span>
              <span class="release-card-stage">{{ stageLabel(card) }}</span>
            </button>
          </li>
          <li v-if="rel.cards.length === 0" class="release-empty">No cards in this release</li>
        </ul>
      </div>
      <div v-if="doneReleases.length === 0" class="releases-empty-state">
        Nothing shipped yet. Mark a release done from its folder once it's live.
      </div>
    </div>

    <dialog ref="confirmEl" v-modal class="release-dialog" aria-labelledby="release-done-title" @close="confirmId = null">
      <form v-if="confirmRelease" method="dialog" class="dialog-form" @submit.prevent="submitDone">
        <h2 id="release-done-title">Mark “{{ confirmRelease.title }}” done?</h2>
        <p class="release-dialog-schedule">
          It moves to the Done tab and stops taking cards. You can reopen it later.
        </p>
        <label v-if="confirmUnfinished > 0" class="checkbox-row">
          <input v-model="confirmCompleteCards" type="checkbox" />
          Also mark its {{ confirmUnfinished }} unfinished card{{ confirmUnfinished === 1 ? '' : 's' }} Done
        </label>
        <div class="dialog-actions">
          <span class="spacer"></span>
          <button type="button" class="btn" @click="requestDialogClose(confirmEl)">Cancel</button>
          <button type="submit" class="btn btn-primary"><PhCheck :size="15" weight="bold" aria-hidden="true" />Mark done</button>
        </div>
      </form>
    </dialog>
  </section>
</template>
