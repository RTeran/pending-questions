import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PromptSubmitInput, Register, RenderNode } from 'claude-code'

import type { Action, ChainState, Option, Question, ScrollCache, Section, TasksSource, Unseen, View } from '../types'

const PANE = 'pending-questions'
const TITLE = 'Agent inbox'
const OPEN_TOOL = 'mcp__pending-questions__question_open'
const CLOSE_TOOL = 'mcp__pending-questions__question_close'
const ACTION_OPEN_TOOL = 'mcp__pending-questions__action_open'
const ACTION_CLOSE_TOOL = 'mcp__pending-questions__action_close'
const LOCALE = 'en-US'

const questions = atom({ plugin: 'pending-questions', key: 'questions' } as const, [] as Question[], {
  shape: 'questions-1',
})
const view = atom({ plugin: 'pending-questions', key: 'view' } as const, { kind: 'list' } as View, {
  shape: 'view-2',
})
const LIST: View = { kind: 'list' }

const NO_TASKS: TasksSource = {
  path: '',
  exists: false,
  text: '',
  hash: '',
  isTooLarge: false,
  draft: '',
  isDismissed: false,
  isSetupAsked: false,
  isConfirmed: false,
}
const tasks = atom({ plugin: 'pending-questions', key: 'tasks' } as const, NO_TASKS, { shape: 'tasks-1' })
const unseen = atom(
  { plugin: 'pending-questions', key: 'unseen' } as const,
  { questions: false, actions: false, tasks: false } as Unseen,
  { shape: 'unseen-1' },
)

const actions = atom({ plugin: 'pending-questions', key: 'actions' } as const, [] as Action[], {
  shape: 'actions-1',
})

const now = atom({ plugin: 'pending-questions', key: 'now' } as const, '')

const scroll = atom({ plugin: 'pending-questions', key: 'scroll' } as const, { key: '', contentRows: 0 } as ScrollCache, {
  shape: 'scroll-1',
})
let drawnKey = ''

const pad = (n: number) => String(n).padStart(2, '0')

const dayOf = (t: Date) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`

export const clockOf = (iso: string) => {
  const t = new Date(iso)
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`
}

export const stampOf = (iso: string) => {
  const t = new Date(iso)
  return `${dayOf(t)} ${clockOf(iso)}`
}

export const ageOf = (iso: string, at: Date) => {
  const minutes = Math.floor((at.getTime() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / (24 * 60))} d ago`
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export const dayLabelOf = (iso: string, at: Date) => {
  const t = new Date(iso)
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(at) - midnight(t)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  try {
    if (days > 1 && days < 7) return capitalize(new Intl.DateTimeFormat(LOCALE, { weekday: 'long' }).format(t))
    const year = t.getFullYear() === at.getFullYear() ? {} : { year: 'numeric' as const }
    return capitalize(new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', ...year }).format(t))
  } catch {
    return dayOf(t)
  }
}

export const groupByDay = (list: readonly Question[], at: Date) => {
  const groups: { day: string; label: string; items: Question[] }[] = []
  for (const q of [...list].sort((a, b) => a.askedAt.localeCompare(b.askedAt))) {
    const day = dayOf(new Date(q.askedAt))
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(q)
    else groups.push({ day, label: dayLabelOf(q.askedAt, at), items: [q] })
  }
  return groups
}

export const spansDays = (list: readonly Question[], at: Date) => list.some(q => dayOf(new Date(q.askedAt)) !== dayOf(at))

export const answerTextOf = (q: Question, answer: string) => `[Q${q.n} · asked ${stampOf(q.askedAt)}] ${answer.trim()}`

export const answeredRef = (text: string) => {
  const match = /^\s*\[Q(\d+)\b/.exec(text)
  return match ? Number(match[1]) : undefined
}

export const doneTextOf = (n: number) => `[A${n} · done]`

export const doneRef = (text: string) => {
  const match = /^\s*\[A(\d+)\b/.exec(text)
  return match ? Number(match[1]) : undefined
}

export const optionTextOf = (o: Option) => `${o.key}: ${o.label}`

const lineRows = (line: string, columns: number) => {
  let rows = 1
  let used = 0
  for (const word of line.split(' ')) {
    const length = [...word].length
    const needed = used === 0 ? length : used + 1 + length
    if (needed <= columns) {
      used = needed
      continue
    }
    const room = used === 0 || length <= columns ? 0 : columns - used - 1
    const fromHere = room > 0 ? Math.ceil((length - room) / columns) : Infinity
    const fromNext = (used > 0 ? 1 : 0) + Math.ceil(length / columns) - 1
    const tail = fromHere <= fromNext ? length - room : length
    rows += Math.min(fromHere, fromNext)
    used = tail % columns || columns
  }
  return rows
}

export const rowsOf = (text: string, columns: number) =>
  text.split('\n').reduce((sum, line) => sum + lineRows(line, Math.max(1, columns)), 0)

const isWide = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf)
}

export const widthOf = (text: string) => [...text].reduce((sum, char) => sum + (isWide(char) ? 2 : 1), 0)

export const navRowsOf = (labels: readonly string[], columns: number, gap = 2) => {
  let rows = 1
  let used = 0
  for (const label of labels) {
    const width = Math.min(widthOf(label), columns)
    if (used > 0 && used + gap + width > columns) {
      rows += 1
      used = width
    } else {
      used += (used > 0 ? gap : 0) + width
    }
  }
  return rows
}

const stackRows = (children: readonly number[]) =>
  children.length === 0 ? 0 : children.reduce((sum, rows) => sum + rows, 0) + children.length - 1

const listHeaderOf = (q: Question, at: Date) =>
  `Q${q.n} · ${clockOf(q.askedAt)} · ${ageOf(q.askedAt, at)}${q.queuedAt ? ' · ⏳ queued' : ''}`

export const listRows = (list: readonly Question[], at: Date, columns: number) => {
  const showDays = spansDays(list, at)
  return stackRows(
    groupByDay(list, at).map(group =>
      stackRows([
        ...(showDays ? [rowsOf(`── ${group.label} ──`, columns)] : []),
        ...group.items.map(q => rowsOf(listHeaderOf(q, at), columns) + rowsOf(q.question, columns)),
      ]),
    ),
  )
}

const ANSWER_FIELD_ROWS = 4

const sentLineOf = (queuedAt: string) => `⏳ Sent at ${clockOf(queuedAt)}: it arrives when the lead ends its turn.`

export const detailRows = (q: Question, at: Date, columns: number) =>
  stackRows([
    1,
    rowsOf(`Q${q.n} · asked ${stampOf(q.askedAt)} · ${ageOf(q.askedAt, at)}`, columns) + rowsOf(q.question, columns),
    ...(q.context !== '' ? [rowsOf(q.context, columns)] : []),
    ...(q.options.length > 0
      ? [
          q.options.reduce(
            (sum, o) => sum + rowsOf(`○ ${optionTextOf(o)}${o.key === q.recommended ? ' (recommended)' : ''}`, columns),
            0,
          ),
        ]
      : []),
    q.queuedAt ? rowsOf(sentLineOf(q.queuedAt), columns) : ANSWER_FIELD_ROWS + 1,
  ])

const actionHeaderOf = (a: Action, at: Date) =>
  `A${a.n} · ${clockOf(a.askedAt)} · ${ageOf(a.askedAt, at)}${a.queuedAt ? ' · ⏳ queued' : ''}`

const doneLineOf = (queuedAt: string) => `⏳ Marked done at ${clockOf(queuedAt)}: it arrives when the lead ends its turn.`

export const actionListRows = (list: readonly Action[], at: Date, columns: number) =>
  stackRows([1, ...(list.length === 0 ? [1] : list.map(a => rowsOf(actionHeaderOf(a, at), columns) + rowsOf(a.action, columns)))])

export const actionDetailRows = (a: Action, at: Date, columns: number) =>
  stackRows([
    1,
    rowsOf(`A${a.n} · asked ${stampOf(a.askedAt)} · ${ageOf(a.askedAt, at)}`, columns) + rowsOf(a.action, columns),
    ...(a.context !== '' ? [rowsOf(a.context, columns)] : []),
    ...(a.url ? [rowsOf(a.url, columns)] : []),
    a.queuedAt ? rowsOf(doneLineOf(a.queuedAt), columns) : 1,
  ])

export const normalize = (text: string) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd())
  const kept = lines.filter((line, i) => line !== '' || (i > 0 && lines[i - 1] !== ''))
  while (kept[0] === '') kept.shift()
  while (kept[kept.length - 1] === '') kept.pop()
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

export const hashOf = (text: string) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/

const STATUS = /^\s*(?:[-*+]\s+)?status\s*:\s*(.*?)\s*$/i
const TASK_ID = /^([a-z]+-\d+)(?:\s|$)/i

// A heading that starts with a task id (`T-12 Fix the login`) is that task whatever its title
// says, so renaming it in ClickUp is not a new task.
const taskKeyOf = (heading: string) => TASK_ID.exec(heading)?.[1] ?? heading

// A file like the ClickUp sync's TASKS.md has no checkboxes: each task is a heading with a
// `status:` line under it, so a status is matched to the nearest heading above it.
const outlineOf = (text: string) => {
  const items = new Map<string, boolean>()
  const headings = new Set<string>()
  const statuses = new Map<string, string>()
  let heading: string | undefined
  for (const line of normalize(text).split('\n')) {
    const item = CHECKBOX.exec(line)
    if (item) {
      const label = item[2]?.trim() ?? ''
      if (!items.has(label)) items.set(label, item[1] !== ' ')
      continue
    }
    const title = HEADING.exec(line)
    if (title) {
      heading = taskKeyOf(title[1]?.trim() ?? '')
      headings.add(heading)
      continue
    }
    const status = STATUS.exec(line)
    if (status && heading !== undefined && !statuses.has(heading)) statuses.set(heading, (status[1] ?? '').toLowerCase())
  }
  return { items, headings, statuses }
}


export type TasksChange = {
  done: number
  reopened: number
  added: number
  sections: number
  statuses: number
  isNotable: boolean
  text: string
}

export const summarizeChange = (prev: string, next: string): TasksChange => {
  const before = outlineOf(prev)
  const after = outlineOf(next)
  let done = 0
  let reopened = 0
  let added = 0
  for (const [label, isChecked] of after.items) {
    const was = before.items.get(label)
    if (was === undefined) added++
    else if (!was && isChecked) done++
    else if (was && !isChecked) reopened++
  }
  const sections = [...after.headings].filter(heading => !before.headings.has(heading)).length
  const statusChanges = [...after.statuses].flatMap(([heading, status]) => {
    const was = before.statuses.get(heading)
    return was === undefined || was === status ? [] : [`${heading} status: ${was} → ${status}`]
  })
  const counts = ([
    [done, 'done'],
    [reopened, 'reopened'],
    [added, 'added'],
  ] as const).filter(([count]) => count > 0)
  const all = [
    ...counts.map(([count, word], i) => (i === 0 ? `${countOf(count, 'task', 'tasks')} ${word}` : `${count} ${word}`)),
    ...(sections > 0 ? [countOf(sections, 'new section', 'new sections')] : []),
    ...(statusChanges.length > 2 ? [countOf(statusChanges.length, 'status change', 'status changes')] : statusChanges),
  ]
  return {
    done,
    reopened,
    added,
    sections,
    statuses: statusChanges.length,
    isNotable: all.length > 0,
    text: all.join(', '),
  }
}

export type Thumb = { start: number; size: number }

export const thumbOf = ({ offset, bodyRows, contentRows }: { offset: number; bodyRows: number; contentRows: number }) => {
  if (bodyRows <= 0 || contentRows <= bodyRows) return undefined
  const size = Math.max(1, Math.round((bodyRows * bodyRows) / contentRows))
  const travel = bodyRows - size
  const ratio = Math.min(1, Math.max(0, offset / (contentRows - bodyRows)))
  return { start: Math.round(ratio * travel), size } satisfies Thumb
}

const ANSWER_ORIGINS = new Set(['composer', 'bridge', 'plugin'])

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const optionsOf = (raw: unknown): Option[] =>
  Array.isArray(raw)
    ? raw
        .map((one, i) =>
          typeof one === 'string'
            ? { key: LETTERS[i] ?? String(i + 1), label: one }
            : {
                key: String((one as Partial<Option>)?.key ?? LETTERS[i] ?? i + 1),
                label: String((one as Partial<Option>)?.label ?? ''),
              },
        )
        .filter(one => one.label.trim() !== '')
    : []

const isQuestionList = (value: unknown): value is Question[] =>
  Array.isArray(value) && value.every(q => typeof q?.n === 'number' && typeof q?.question === 'string' && typeof q?.askedAt === 'string')

const isActionList = (value: unknown): value is Action[] =>
  Array.isArray(value) && value.every(a => typeof a?.n === 'number' && typeof a?.action === 'string' && typeof a?.askedAt === 'string')

const SAMPLE_RATE = 22_050

const wavOf = (samples: Float32Array) => {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const data = new DataView(bytes.buffer)
  const text = (at: number, value: string) => [...value].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  data.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, 1, true)
  data.setUint32(24, SAMPLE_RATE, true)
  data.setUint32(28, SAMPLE_RATE * 2, true)
  data.setUint16(32, 2, true)
  data.setUint16(34, 16, true)
  text(36, 'data')
  data.setUint32(40, samples.length * 2, true)
  samples.forEach((v, i) => data.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32_767), true))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const dingOf = (seconds: number, hz: number) =>
  Float32Array.from({ length: Math.round(SAMPLE_RATE * seconds) }, (_, i) => {
    const t = i / SAMPLE_RATE
    const attack = Math.min(1, t / 0.005)
    const tone = Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(4 * Math.PI * hz * t)
    return 0.4 * attack * Math.exp(-t * 14) * tone
  })

export const ACK_SOUND = { base64: wavOf(dingOf(0.35, 1_320)), mime: 'audio/wav' } as const

const SOUND_GAP_MS: Record<Section, number> = { questions: 1_000, actions: 1_000, tasks: 60_000 }
const lastSoundAt: Record<Section, number> = { questions: -Infinity, actions: -Infinity, tasks: -Infinity }

const logDebug = ($: Engine, text: string) => {
  try {
    $.ui.log(`pending-questions: ${text}`, { to: 'debug' })
  } catch {
    // A sound is a courtesy: losing its log line must not fail the question.
  }
}

const logSoundFailure = ($: Engine, error: unknown, section = 'new-item') =>
  logDebug($, `the ${section} sound did not play: ${String(error)}`)

export type Sound = 'alert' | 'ding' | 'off'

const SOUNDS: readonly unknown[] = ['alert', 'ding', 'off']

export const soundOf = (raw: unknown): Sound => {
  if (raw === false) return 'off'
  return SOUNDS.includes(raw) ? (raw as Sound) : 'alert'
}

export const isUnknownSound = (raw: unknown) => raw !== undefined && raw !== false && !SOUNDS.includes(raw)

const ALERT_ARGV = ['/usr/bin/osascript', '-e', 'beep']

async function playAlert($: Engine) {
  const { exitCode, stderr } = await $.process.run(ALERT_ARGV, { timeoutMs: 5_000 })
  if (exitCode !== 0) logSoundFailure($, `osascript exit code ${exitCode}: ${stderr.trim()}`)
}

export async function chime(
  $: Engine,
  sound: Sound,
  gate: Section = 'questions',
): Promise<{ played: Promise<void> | undefined }> {
  if (sound === 'off') return { played: undefined }
  try {
    const at = await $.clock.now()
    if (at - lastSoundAt[gate] < SOUND_GAP_MS[gate]) return { played: undefined }
    const previous = lastSoundAt[gate]
    lastSoundAt[gate] = at
    const played = Promise.resolve()
      .then(() => (sound === 'alert' ? playAlert($) : $.audio.play(ACK_SOUND)))
      .catch(error => {
        if (lastSoundAt[gate] === at) lastSoundAt[gate] = previous
        logSoundFailure($, error, gate)
      })
    return { played }
  } catch (error) {
    logSoundFailure($, error, gate)
    return { played: undefined }
  }
}

type OpenInput = { question?: unknown; context?: unknown; options?: unknown; recommended?: unknown }
type CloseInput = { n?: unknown; reason?: unknown }
type ActionOpenInput = { action?: unknown; context?: unknown; url?: unknown }

// A /clear gives the process a new session id without a session.start. The store keys stay
// on the id the chain started with, so open items and their numbering outlive the /clear.
// Any other id change (a /resume, or one no session.end announced) moves to that
// conversation's own chain. The chain lives in $.state so a reload keeps it; when the state
// is new, the alias finds the chain again and the open items come back from the store.
const NO_CHAIN: ChainState = { id: '', seen: '', endReason: '' }
const chain = atom({ plugin: 'pending-questions', key: 'chain' } as const, NO_CHAIN, { shape: 'chain-1' })
let chainId = ''
let seenId = ''
let endReason = ''

async function chainOf($: Engine, id: string) {
  const alias = await $.store.get(`alias:${id}`)
  return typeof alias === 'string' && alias !== '' ? alias : id
}

async function keysOf($: Engine) {
  const id = await $.session.id()
  const known = await read($, chain)
  const isFresh = known.id === ''
  if (chainId === '') {
    chainId = known.id
    seenId = known.seen
    endReason = endReason || known.endReason
  }
  let isMoved = false
  let isChanged = isFresh
  if (chainId === '') {
    chainId = await chainOf($, id)
    seenId = id
  } else if (id !== seenId) {
    if (endReason === 'clear') await $.store.set(`alias:${id}`, chainId)
    else {
      chainId = await chainOf($, id)
      isMoved = true
    }
    seenId = id
    endReason = ''
    isChanged = true
  }
  if (isChanged) await update($, chain, () => ({ id: chainId, seen: seenId, endReason }))
  const keys = {
    open: `open:${chainId}`,
    seq: `seq:${chainId}`,
    actions: `actions:${chainId}`,
    actionSeq: `aseq:${chainId}`,
  }
  if (isMoved) await replaceLists($, keys)
  else if (isFresh) await restoreLists($, keys)
  return keys
}

async function noteSessionEnd($: Engine, reason: unknown) {
  endReason = reason === 'clear' ? 'clear' : 'other'
  await update($, chain, c => ({ ...c, endReason }))
}

async function replaceLists($: Engine, keys: { open: string; actions: string }) {
  await update($, questions, () => [])
  await update($, actions, () => [])
  await update($, unseen, () => ({ questions: false, actions: false, tasks: false }))
  await update($, view, () => LIST)
  await restoreLists($, keys)
}

async function restoreLists($: Engine, keys: { open: string; actions: string }) {
  if ((await read($, questions)).length === 0) {
    const stored = await $.store.get(keys.open)
    if (isQuestionList(stored) && stored.length > 0) {
      await update($, questions, () => stored.map(({ queuedAt: _, ...q }) => q))
    } else if (stored !== undefined && !isQuestionList(stored)) {
      logDebug($, `the stored questions are in an unknown shape and were not restored`)
    }
  }
  if ((await read($, actions)).length === 0) {
    const stored = await $.store.get(keys.actions)
    if (isActionList(stored) && stored.length > 0) {
      await update($, actions, () => stored.map(({ queuedAt: _, ...a }) => a))
    } else if (stored !== undefined && !isActionList(stored)) {
      logDebug($, `the stored actions are in an unknown shape and were not restored`)
    }
  }
}

const countOf = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

async function save($: Engine) {
  const keys = await keysOf($)
  const list = await read($, questions)
  const todo = await read($, actions)
  await $.store.set(keys.open, list)
  await $.store.set(keys.actions, todo)
  await refreshStatus($)
}

export const taskCountsOf = (text: string) => {
  const boxes = normalize(text)
    .split('\n')
    .map(line => CHECKBOX.exec(line))
    .filter(match => match !== null)
  if (boxes.length > 0) return { done: boxes.filter(match => match[1] !== ' ').length, total: boxes.length }
  const statuses = [...outlineOf(text).statuses.values()]
  return { done: statuses.filter(status => status === 'done').length, total: statuses.length }
}

const hasCheckboxes = (text: string) => normalize(text).split('\n').some(line => CHECKBOX.test(line))

const needsTasksSetup = (source: TasksSource) =>
  !source.exists && source.path !== '' && !source.isDismissed && source.isConfirmed !== true

const tasksLabelOf = (source: TasksSource) => {
  if (!source.exists) return needsTasksSetup(source) ? 'set up' : ''
  const { done, total } = taskCountsOf(source.isTooLarge ? '' : source.text)
  return total === 0 ? '' : `${done}/${total}`
}

async function refreshStatus($: Engine) {
  const list = await read($, questions)
  const todo = await read($, actions)
  const source = await read($, tasks)
  const counts = source.exists && !source.isTooLarge ? taskCountsOf(source.text) : { done: 0, total: 0 }
  const parts = [
    ...(list.length > 0 ? [`❓ ${countOf(list.length, 'question', 'questions')}`] : []),
    ...(todo.length > 0 ? [`🛠 ${countOf(todo.length, 'action', 'actions')}`] : []),
    ...(counts.total > 0 ? [`📋 ${counts.done}/${counts.total} tasks`] : []),
  ]
  $.ui.status(parts.length === 0 ? undefined : `${parts.join(' · ')} · /questions`)
}

const VIEW_OF: Record<Section, View> = { questions: { kind: 'list' }, actions: { kind: 'actions' }, tasks: { kind: 'tasks' } }

export const sectionOf = (shown: View): Section =>
  shown.kind === 'actions' || shown.kind === 'action'
    ? 'actions'
    : shown.kind === 'tasks' || shown.kind === 'tasks-setup'
      ? 'tasks'
      : 'questions'

const SECTION_ORDER: readonly Section[] = ['questions', 'actions', 'tasks']

const hasTasksContent = (source: TasksSource) => source.exists || needsTasksSetup(source)

export const effectiveSectionOf = (preferred: Section, questionCount: number, actionCount: number, hasTasks: boolean) => {
  const hasContent: Record<Section, boolean> = { questions: questionCount > 0, actions: actionCount > 0, tasks: hasTasks }
  return hasContent[preferred] ? preferred : SECTION_ORDER.find(section => hasContent[section])
}

async function openSection($: Engine, section: Section) {
  await update($, unseen, marks => ({ ...marks, [section]: false }))
  await update($, view, () => VIEW_OF[section])
}

// A section the human picked stays shown even when empty; only when its content goes away on its
// own does the pane move to the first section that still has something.
async function settleView($: Engine, changed?: Section) {
  const shownView = await read($, view)
  if (shownView.kind === 'question' || shownView.kind === 'action') return
  const preferred = sectionOf(shownView)
  if (changed && changed !== preferred) return
  const shown =
    effectiveSectionOf(
      preferred,
      (await read($, questions)).length,
      (await read($, actions)).length,
      hasTasksContent(await read($, tasks)),
    ) ?? preferred
  if (shown !== preferred) await update($, view, () => VIEW_OF[shown])
  await update($, unseen, marks => (marks[shown] ? { ...marks, [shown]: false } : marks))
}

async function leaveDetail($: Engine, kind: 'question' | 'action', n: number) {
  let isLeft = false
  await update($, view, current => {
    isLeft = current.kind === kind && current.n === n
    return isLeft ? VIEW_OF[sectionOf(current)] : current
  })
  const section = kind === 'question' ? 'questions' : 'actions'
  if (isLeft) await update($, unseen, marks => ({ ...marks, [section]: false }))
  await settleView($, section)
}

async function isPaneShown($: Engine) {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  } catch (error) {
    logDebug($, `the pane state could not be read; the view stays where it is: ${String(error)}`)
    return true
  }
}

// While the human is in a question or an action on a shown pane, the pane stays put: the change is marked on
// its menu button instead. Tasks then make no sound either, as they are never urgent.
async function notifyChange($: Engine, sound: Sound, section: Section, text?: string) {
  let isInDetail = false
  try {
    const shown = await read($, view)
    isInDetail = (shown.kind === 'question' || shown.kind === 'action') && (await isPaneShown($))
    if (isInDetail) await update($, unseen, marks => ({ ...marks, [section]: true }))
    else await openSection($, section)
  } catch (error) {
    logDebug($, `the pane state for the ${section} change could not be written: ${String(error)}`)
  }
  if (!isInDetail || section !== 'tasks') {
    try {
      await chime($, sound, section)
    } catch (error) {
      logSoundFailure($, error, section)
    }
  }
  if (!isInDetail) openPane($)
  if (text) {
    try {
      $.ui.toast(text)
    } catch (error) {
      logDebug($, `the ${section} toast could not be shown: ${String(error)}`)
    }
  }
}

function openPane($: Engine) {
  Promise.resolve()
    .then(() => $.ui.open({ id: PANE, title: TITLE }))
    .catch(error => logDebug($, `the pane did not open: ${String(error)}`))
}

async function removeAction($: Engine, n: number) {
  let isRemoved = false
  await update($, actions, all => {
    isRemoved = all.some(a => a.n === n)
    return isRemoved ? all.filter(a => a.n !== n) : all
  })
  if (!isRemoved) return false
  await leaveDetail($, 'action', n)
  await save($)
  return true
}

async function resolveAction($: Engine, n: number) {
  if (await removeAction($, n)) $.ui.toast(`A${n} done.`)
}

async function markDone($: Engine, n: number) {
  let isSent = false
  try {
    const a = (await read($, actions)).find(one => one.n === n)
    if (!a || a.queuedAt) return
    await update($, actions, all => all.map(one => (one.n === n ? { ...one, queuedAt: new Date().toISOString() } : one)))
    await openSection($, 'actions')
    await save($)
    await $.prompt.submit({ text: doneTextOf(n), asUser: true })
    isSent = true
    await resolveAction($, n)
  } catch (error) {
    if (isSent) {
      logDebug($, `A${n} was marked done but the pane did not catch up: ${String(error)}`)
      if (!(await dropAction($, n))) await unqueueAction($, n)
      return
    }
    logDebug($, `A${n} could not be marked done: ${String(error)}`)
    $.ui.toast(
      (await unqueueAction($, n))
        ? `Could not mark A${n} as done. It is still pending.`
        : `Could not mark A${n} as done, and its Done button could not be reset. Restart the session to try again.`,
    )
  }
}

async function dropAction($: Engine, n: number) {
  try {
    await update($, actions, all => all.filter(one => one.n !== n))
    await leaveDetail($, 'action', n)
  } catch (error) {
    logDebug($, `A${n} could not be taken out of the pane: ${String(error)}`)
    return false
  }
  try {
    await save($)
  } catch (error) {
    logDebug($, `the pane without A${n} could not be saved: ${String(error)}`)
  }
  return true
}

async function unqueueAction($: Engine, n: number) {
  try {
    await update($, actions, all => all.map(one => (one.n === n ? { ...one, queuedAt: undefined } : one)))
  } catch (error) {
    logDebug($, `A${n} could not be put back as pending: ${String(error)}`)
    return false
  }
  try {
    await save($)
  } catch (error) {
    logDebug($, `A${n} is pending again but could not be saved: ${String(error)}`)
  }
  return true
}

async function resolveQuestion($: Engine, n: number) {
  let isRemoved = false
  await update($, questions, all => {
    isRemoved = all.some(q => q.n === n)
    return isRemoved ? all.filter(q => q.n !== n) : all
  })
  if (!isRemoved) return
  await leaveDetail($, 'question', n)
  await save($)
  $.ui.toast(`Q${n} answered.`)
}

function setDraft($: Engine, n: number, draft: string) {
  return update($, questions, all => all.map(q => (q.n === n ? { ...q, draft } : q)))
}

async function send($: Engine, n: number, raw: string) {
  let isSent = false
  try {
    const answer = raw.trim()
    const q = (await read($, questions)).find(one => one.n === n)
    if (!q || q.queuedAt) return
    if (answer === '') {
      $.ui.toast('Write an answer or pick an option before sending.')
      return
    }
    await update($, questions, all =>
      all.map(one => (one.n === n ? { ...one, draft: answer, queuedAt: new Date().toISOString() } : one)),
    )
    await openSection($, 'questions')
    await save($)
    await $.prompt.submit({ text: answerTextOf(q, answer), asUser: true })
    isSent = true
    await resolveQuestion($, n)
  } catch (error) {
    if (isSent) {
      logDebug($, `the answer to Q${n} was sent but the pane did not catch up: ${String(error)}`)
      if (!(await dropQuestion($, n))) await unqueueQuestion($, n)
      return
    }
    logDebug($, `the answer to Q${n} could not be sent: ${String(error)}`)
    $.ui.toast(
      (await unqueueQuestion($, n))
        ? `Could not send the answer to Q${n}. It is still pending.`
        : `Could not send the answer to Q${n}, and its answer field could not be reset. Restart the session to try again.`,
    )
  }
}

async function dropQuestion($: Engine, n: number) {
  try {
    await update($, questions, all => all.filter(one => one.n !== n))
    await leaveDetail($, 'question', n)
  } catch (error) {
    logDebug($, `Q${n} could not be taken out of the pane: ${String(error)}`)
    return false
  }
  try {
    await save($)
  } catch (error) {
    logDebug($, `the pane without Q${n} could not be saved: ${String(error)}`)
  }
  return true
}

async function unqueueQuestion($: Engine, n: number) {
  try {
    await update($, questions, all => all.map(one => (one.n === n ? { ...one, queuedAt: undefined } : one)))
  } catch (error) {
    logDebug($, `Q${n} could not be put back as pending: ${String(error)}`)
    return false
  }
  try {
    await save($)
  } catch (error) {
    logDebug($, `Q${n} is pending again but could not be saved: ${String(error)}`)
  }
  return true
}

async function sendThroughChat($: Engine, n: number, raw: string) {
  const q = (await read($, questions)).find(one => one.n === n)
  if (!q) return
  const { text: typed } = await $.prompt.read()
  const text = answerTextOf(q, raw)
  await $.prompt.fill(typed.trim() === '' ? { text, mode: 'replace' } : { text: `\n\n${text}`, mode: 'append' })
  await openSection($, 'questions')
  $.ui.toast(`The answer to Q${n} is in the prompt: press Enter to send it.`)
}

// A teammate in a pane of its own is a separate `claude --agent-id …` process, so the hooks
// see it as a main session: only its command line tells it apart.
const TEAMMATE_PROBE = [
  'p=$PPID',
  'for i in 1 2 3 4 5 6; do',
  '  case "$(ps -o args= -p "$p")" in *--agent-i[d]*) echo teammate; exit 0;; esac',
  '  p=$(ps -o ppid= -p "$p" | tr -d " ")',
  '  if [ -z "$p" ] || [ "$p" -le 1 ]; then break; fi',
  'done',
  'echo main',
].join('\n')

const TASKS_POLL_MS = 5_000
const TASKS_MAX_BYTES = 4 * 1024 * 1024
const STABLE_POLLS = 2

type Snapshot = { hash: string; text: string }

type Seen = Snapshot & { path: string }

const isSeenFor = (value: unknown, path: string): value is Seen =>
  (value as Seen | undefined)?.path === path &&
  typeof (value as Seen).hash === 'string' &&
  typeof (value as Seen).text === 'string'

export const tasksInstructionOf = (path: string, source?: TasksSource) =>
  source?.exists && !source.isTooLarge && source.text !== '' && !hasCheckboxes(source.text)
    ? `If you are the main session, not a subagent or a teammate, your task list is in ${path}; keep its current format.`
    : `If you are the main session, not a subagent or a teammate, keep your task list in ${path}, using \`- [ ]\` / \`- [x]\` checkboxes.`

export const resolvePath = (path: string, root: string, home: string) => {
  const expanded = home !== '' && (path === '~' || path.startsWith('~/')) ? `${home}${path.slice(1)}` : path
  const absolute = expanded.startsWith('/') ? expanded : `${root}/${expanded}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

let isLead = false
let homeDir = ''
let tasksRoot = ''
let tasksPath = ''
let lastStat = ''
let lastReadError = ''
let current: Snapshot = { hash: hashOf(''), text: '' }
let committed: Snapshot | undefined
let pending = { hash: '', count: 0 }
let polling: { cancel: () => void } | undefined
let observing: Promise<void> = Promise.resolve()

function reportReadError($: Engine, error: unknown) {
  const text = String(error)
  if (text === lastReadError) return
  lastReadError = text
  logDebug($, `the tasks file ${tasksPath} could not be read: ${text}`)
}

async function markMissing($: Engine) {
  lastStat = ''
  lastReadError = ''
  await update($, tasks, t => ({ ...t, exists: false, isTooLarge: false }))
  await refreshStatus($)
}

// A missing, oversized or unreadable file is never taken as an empty one: the baseline stays,
// so a git checkout or a passing error cannot report tasks as removed and then as added.
async function readTasks($: Engine): Promise<'fresh' | 'unchanged' | 'unusable'> {
  let stat: { size: number; mtimeMs: number; kind: string }
  try {
    if (!(await $.fs.exists(tasksPath))) {
      await markMissing($)
      return 'unusable'
    }
    stat = await $.fs.stat(tasksPath)
  } catch (error) {
    reportReadError($, error)
    return 'unusable'
  }
  if (stat.kind !== 'file') {
    await markMissing($)
    return 'unusable'
  }
  const key = `${stat.size}:${stat.mtimeMs}`
  if (key === lastStat) return 'unchanged'
  if (stat.size > TASKS_MAX_BYTES) {
    lastStat = key
    lastReadError = ''
    await update($, tasks, t => ({ ...t, exists: true, isTooLarge: true }))
    await refreshStatus($)
    return 'unusable'
  }
  let raw: unknown
  try {
    raw = await $.fs.read(tasksPath)
  } catch (error) {
    reportReadError($, error)
    return 'unusable'
  }
  if (typeof raw !== 'string') {
    reportReadError($, 'the read did not return text')
    return 'unusable'
  }
  const text = normalize(raw)
  lastStat = key
  lastReadError = ''
  current = { hash: hashOf(text), text }
  await update($, tasks, t => ({ ...t, exists: true, text, hash: current.hash, isTooLarge: false }))
  await refreshStatus($)
  return 'fresh'
}

async function commit($: Engine, next: Snapshot) {
  committed = next
  pending = { hash: '', count: 0 }
  try {
    await $.store.set(`tasksSeen:${tasksRoot}`, { path: tasksPath, ...next } satisfies Seen)
  } catch (error) {
    logDebug($, `the tasks baseline could not be saved: ${String(error)}`)
  }
}

async function observeTasks($: Engine, sound: Sound, isPoll: boolean) {
  if (tasksPath === '') return
  if ((await readTasks($)) === 'unusable') return
  if (!committed) return commit($, current)
  if (!isPoll) return
  if (current.hash === committed.hash) {
    pending = { hash: '', count: 0 }
    return
  }
  pending = pending.hash === current.hash ? { hash: current.hash, count: pending.count + 1 } : { hash: current.hash, count: 1 }
  if (pending.count < STABLE_POLLS) return
  const change = summarizeChange(committed.text, current.text)
  await commit($, current)
  if (change.isNotable) await notifyChange($, sound, 'tasks', change.text)
}

function observe($: Engine, sound: Sound, isPoll: boolean) {
  observing = observing
    .then(() => observeTasks($, sound, isPoll))
    .catch(error => logDebug($, `the tasks check failed: ${String(error)}`))
  return observing
}

async function chooseTasksPath($: Engine, sound: Sound, raw: string) {
  const typed = raw.trim()
  if (typed === '') {
    $.ui.toast('Write the path of the tasks file first.')
    return
  }
  try {
    const path = resolvePath(typed, tasksRoot, homeDir)
    await $.store.set(`tasksFile:${tasksRoot}`, path)
    await openSection($, 'tasks')
    await useTasksPath($, sound, path, true)
    $.ui.toast(`Tasks file set to ${path}.`)
  } catch (error) {
    logDebug($, `the tasks path could not be used: ${String(error)}`)
    $.ui.toast('Could not use that path. Try again.')
  }
}

async function dismissTasksSetup($: Engine) {
  try {
    await update($, tasks, t => ({ ...t, isDismissed: true }))
    await settleView($, 'tasks')
  } catch (error) {
    logDebug($, `the tasks setup could not be dismissed: ${String(error)}`)
    $.ui.toast('Could not close the setup. Try again.')
  }
}

async function refreshOnWrite($: Engine, sound: Sound, filePath: unknown) {
  try {
    if (isLead && tasksPath !== '' && typeof filePath === 'string' && resolvePath(filePath, tasksRoot, homeDir) === tasksPath) {
      await observe($, sound, false)
    }
  } catch (error) {
    logDebug($, `the tasks file was not refreshed after a write: ${String(error)}`)
  }
}

async function reopenTasksSetup($: Engine) {
  try {
    await update($, tasks, t => ({ ...t, isDismissed: false, isConfirmed: false, draft: t.path }))
  } catch (error) {
    logDebug($, `the tasks setup could not be reopened: ${String(error)}`)
    $.ui.toast('Could not open the setup. Try again.')
  }
}

async function useTasksPath($: Engine, sound: Sound, path: string, isConfirmed: boolean) {
  tasksPath = path
  lastStat = ''
  lastReadError = ''
  committed = undefined
  pending = { hash: '', count: 0 }
  const seen = await $.store.get(`tasksSeen:${tasksRoot}`)
  if (isSeenFor(seen, path)) committed = { hash: seen.hash, text: seen.text }
  await update($, tasks, t => ({ ...t, path, draft: path, isConfirmed, isDismissed: isConfirmed ? false : t.isDismissed }))
  await observe($, sound, true)
}

let sentTasksLine = ''
let messagesAtLastPrompt = 0

async function messageCountOf($: Engine) {
  try {
    const messages = await $.session.messages()
    return Array.isArray(messages) ? messages.length : 0
  } catch (error) {
    logDebug($, `the conversation length could not be read: ${String(error)}`)
    return 0
  }
}

// The line rides beside the human's prompt rather than in the system prompt: an organization's
// policy plugin skips other plugins' prompt.compose hooks, but keeps their prompt.submit context.
// It is sent again when it changes or when the conversation got shorter (a /compact or a /clear).
async function withTasksLine($: Engine, e: PromptSubmitInput): Promise<PromptSubmitInput> {
  if (!isLead || tasksPath === '' || e.command || e.isMeta || !ANSWER_ORIGINS.has(e.origin.kind)) return e
  try {
    const text = tasksInstructionOf(tasksPath, await read($, tasks))
    const count = await messageCountOf($)
    const isShorter = count < messagesAtLastPrompt
    messagesAtLastPrompt = count
    if (text === sentTasksLine && !isShorter) return e
    sentTasksLine = text
    return { ...e, context: [...(e.context ?? []), text] }
  } catch (error) {
    logDebug($, `the tasks line was not sent with the prompt: ${String(error)}`)
    return e
  }
}

export async function isTeammateProcess($: Engine) {
  try {
    const { stdout } = await $.process.run(['/bin/sh', '-c', TEAMMATE_PROBE], { timeoutMs: 3000 })
    return stdout.trim() === 'teammate'
  } catch {
    return false
  }
}

export const register: Register = (on, options) => {
  const sound = soundOf(options.sound)
  let isSoundOptionReported = false

  on('session.start', async ($, e, next) => {
    if (await isTeammateProcess($)) return next(e)

    if (!isSoundOptionReported && isUnknownSound(options.sound)) {
      isSoundOptionReported = true
      logDebug($, `unknown sound option ${JSON.stringify(options.sound)}; playing the alert`)
    }

    chainId = ''
    seenId = ''
    endReason = ''
    await keysOf($)

    await $.tool.register({
      name: 'question_open',
      description: [
        'Register a question or a decision for the human in the "Agent inbox" side pane.',
        'Use it only for secondary ones: a question you need answered, or a decision that is the human\'s to make, that you can keep working without, because the answer refines the result but blocks no step you are about to take. Register it, then keep working on whatever does not depend on the answer.',
        'A question or decision you cannot go on without, or whose answer would change what you are about to do, is not secondary: ask it with AskUserQuestion, which stops the session until the human answers, and do not register it here as well.',
        'The pane keeps the question, with the date and time it was asked, until the human answers.',
        'The answer arrives as a user message starting with "[Q<n> · asked <date>]"; it may arrive while you are busy with something else.',
        'Mention the returned Q<n> when you refer to the question in your replies.',
        'Write question, context and option labels in the language the human uses.',
        'Only the main session or the team lead calls this. A subagent or teammate never does: it returns the question to the agent that started it or sends it to the lead, and that session registers it.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, one sentence.' },
          context: { type: 'string', description: 'The minimum context needed to answer without reading the chat.' },
          options: {
            type: 'array',
            description: 'Possible answers, if any. Keys default to A, B, C…',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, label: { type: 'string' } },
              required: ['label'],
            },
          },
          recommended: { type: 'string', description: 'The key of the option you recommend.' },
        },
        required: ['question'],
      },
      isDeferred: false,
    })

    await $.tool.register({
      name: 'question_close',
      description:
        'Remove a pending question from the side pane without an answer, because it no longer matters. Answered questions leave the pane by themselves.',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'The question number, the n of Q<n>.' },
          reason: { type: 'string', description: 'Why it no longer matters, in the human language.' },
        },
        required: ['n'],
      },
      isDeferred: false,
    })

    await $.tool.register({
      name: 'action_open',
      description: [
        'Register an action for the human in the "Agent inbox" side pane: something only the human can do outside the chat, such as merging a pull request, testing something by hand or providing a credential.',
        'Register it, then keep working on whatever does not depend on it.',
        'The pane keeps the action, with the date and time it was registered, until the human marks it done.',
        'When it is done, a user message starting with "[A<n> · done]" arrives; it may arrive while you are busy with something else.',
        'Mention the returned A<n> when you refer to the action in your replies.',
        'Write the action and its context in the language the human uses.',
        'Only the main session or the team lead calls this. A subagent or teammate never does: it returns the action to the agent that started it or sends it to the lead, and that session registers it.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'What the human has to do, one sentence.' },
          context: { type: 'string', description: 'The minimum context needed to do it without reading the chat.' },
          url: { type: 'string', description: 'A link where the action is done, if any: the pull request, the page to test.' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })

    await $.tool.register({
      name: 'action_close',
      description:
        'Remove a pending action from the side pane because it was done elsewhere or no longer matters. Actions the human marks done in the pane leave it by themselves.',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'The action number, the n of A<n>.' },
          reason: { type: 'string', description: 'Why it no longer matters, in the human language.' },
        },
        required: ['n'],
      },
      isDeferred: false,
    })

    await $.command.register({ name: 'questions', description: 'Opens the Agent inbox pane' })

    isLead = true
    try {
      homeDir = (await $.env.get('HOME')) ?? ''
      tasksRoot = await $.session.root()
      const storedPath = await $.store.get(`tasksFile:${tasksRoot}`)
      const optionPath = typeof options.tasksFile === 'string' ? options.tasksFile.trim() : ''
      const isStored = typeof storedPath === 'string' && storedPath !== ''
      const path = isStored ? storedPath : optionPath !== '' ? optionPath : 'TASKS.md'
      await useTasksPath($, sound, resolvePath(path, tasksRoot, homeDir), isStored)
      const source = await read($, tasks)
      if (e.isInteractive && needsTasksSetup(source) && !source.isSetupAsked) {
        await update($, tasks, t => ({ ...t, isSetupAsked: true }))
        await update($, view, () => ({ kind: 'tasks-setup' }) as View)
        await chime($, sound, 'tasks')
        openPane($)
      } else {
        await settleView($)
      }
    } catch (error) {
      logDebug($, `the tasks file could not be set up: ${String(error)}`)
    }
    polling?.cancel()
    polling = $.clock.every(TASKS_POLL_MS, () => void observe($, sound, true))

    await update($, now, () => new Date().toISOString())
    $.clock.every(60_000, () => void update($, now, () => new Date().toISOString()))
    await save($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    sentTasksLine = ''
    messagesAtLastPrompt = 0
    if (isLead) {
      try {
        await noteSessionEnd($, e.reason)
      } catch (error) {
        logDebug($, `the end of the session could not be noted: ${String(error)}`)
      }
    }
    const result = await next(e)
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      polling?.cancel()
      polling = undefined
    }
    if (e.reason === 'clear' && isLead) {
      try {
        await keysOf($)
      } catch (error) {
        logDebug($, `the store keys could not follow the /clear: ${String(error)}`)
      }
    }
    return result
  })

  on('command.run', { command: 'questions' }, async $ => {
    await openSection($, 'questions')
    await settleView($)
    await $.ui.open({ id: PANE, title: TITLE })
    const count = (await read($, questions)).length
    const todo = (await read($, actions)).length
    if (count === 0 && todo === 0) return { text: 'No pending questions or actions.' }
    return {
      text: `Pane opened: ${countOf(count, 'question', 'questions')} and ${countOf(todo, 'action', 'actions')} pending.`,
    }
  })

  on('tool.call', { tool: OPEN_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: 'Subagents and teammates never call this. Put the question in your reply to the agent that started you, or send it to the lead; that session registers it for the human.',
      }
    }
    const input = e as unknown as OpenInput
    const question = typeof input.question === 'string' ? input.question.trim() : ''
    if (question === '') return { deny: 'question is required.' }

    const { seq } = await keysOf($)
    const n = Number((await $.store.get(seq)) ?? 0) + 1
    await $.store.set(seq, n)
    const options = optionsOf(input.options)
    const recommended =
      typeof input.recommended === 'string' && options.some(o => o.key === input.recommended) ? input.recommended : undefined
    const askedAt = new Date().toISOString()
    const entry: Question = {
      n,
      question,
      context: typeof input.context === 'string' ? input.context.trim() : '',
      options,
      ...(recommended ? { recommended } : {}),
      askedAt,
    }
    await update($, questions, all => [...all, entry])
    await save($)
    await notifyChange($, sound, 'questions')

    return {
      result: `Registered as Q${n}, asked ${stampOf(askedAt)}. It stays in the human's pane until answered. Refer to it as Q${n}.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pending-questions failed; ask the human in the chat instead.' }))

  on('tool.call', { tool: CLOSE_TOOL }, async ($, e) => {
    const { n } = e as unknown as CloseInput
    const list = await read($, questions)
    if (typeof n !== 'number' || !list.some(q => q.n === n)) return { deny: `There is no pending Q${String(n)}.` }
    await update($, questions, all => all.filter(q => q.n !== n))
    await leaveDetail($, 'question', n)
    await save($)
    return { result: `Q${n} removed from the pane.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pending-questions failed; ask the human in the chat instead.' }))

  on('tool.call', { tool: ACTION_OPEN_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: 'Subagents and teammates never call this. Put the action in your reply to the agent that started you, or send it to the lead; that session registers it for the human.',
      }
    }
    const input = e as unknown as ActionOpenInput
    const action = typeof input.action === 'string' ? input.action.trim() : ''
    if (action === '') return { deny: 'action is required.' }

    const { actionSeq } = await keysOf($)
    const n = Number((await $.store.get(actionSeq)) ?? 0) + 1
    await $.store.set(actionSeq, n)
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    const askedAt = new Date().toISOString()
    const entry: Action = {
      n,
      action,
      context: typeof input.context === 'string' ? input.context.trim() : '',
      ...(url !== '' ? { url } : {}),
      askedAt,
    }
    await update($, actions, all => [...all, entry])
    await save($)
    await notifyChange($, sound, 'actions')

    return {
      result: `Registered as A${n}, asked ${stampOf(askedAt)}. It stays in the human's pane until marked done. Refer to it as A${n}.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pending-questions failed; ask the human in the chat instead.' }))

  on('tool.call', { tool: ACTION_CLOSE_TOOL }, async ($, e) => {
    const { n } = e as unknown as CloseInput
    if (typeof n !== 'number') return { deny: 'n must be the number of the action, the n of A<n>.' }
    if (!(await removeAction($, n))) return { deny: `There is no pending A${n}.` }
    return { result: `A${n} removed from the pane.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pending-questions failed; ask the human in the chat instead.' }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const result = await next(e)
    await refreshOnWrite($, sound, e.file_path)
    return result
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const result = await next(e)
    await refreshOnWrite($, sound, e.file_path)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(await withTasksLine($, e))
    if (!isLead || e.command || !ANSWER_ORIGINS.has(e.origin.kind)) return result
    try {
      await keysOf($)
      const n = answeredRef(e.text)
      if (n !== undefined) await resolveQuestion($, n)
      const done = doneRef(e.text)
      if (done !== undefined) await resolveAction($, done)
    } catch (error) {
      logDebug($, `a reply could not close its item: ${String(error)}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const key = drawnKey
    const result = await next(e)
    if (key === '') return result
    const cached = await read($, scroll)
    if (cached.key !== key || cached.contentRows !== e.contentRows) {
      await update($, scroll, () => ({ key, contentRows: e.contentRows }))
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    const list = await read($, questions)
    const todo = await read($, actions)
    const source = await read($, tasks)
    const current = await read($, view)
    const stamp = await read($, now)
    const at = stamp ? new Date(stamp) : new Date()

    const open = current.kind === 'question' ? list.find(q => q.n === current.n) : undefined
    const cached = await read($, scroll)
    const columns = Math.max(1, e.props.bodyColumns - 1)

    const withScrollbar = (
      key: string,
      estimate: number,
      content: RenderNode,
      header?: { rows: number; node: RenderNode },
    ) => {
      drawnKey = `${key}:${columns}`
      const { offset, bodyRows } = e.props.scroll
      const contentRows = cached.key === drawnKey ? cached.contentRows : estimate
      const thumb = thumbOf({ offset, bodyRows, contentRows })
      const pinnedRows = header ? header.rows + 1 : 0
      const isPinned = header !== undefined && bodyRows > pinnedRows
      return (
        <Box flexDirection="column" position="relative" paddingRight={1}>
          {isPinned && <Box key="header-room" height={pinnedRows} flexShrink={0} />}
          {header && !isPinned ? (
            <Box flexDirection="column" gap={1}>
              {header.node}
              {content}
            </Box>
          ) : (
            content
          )}
          {isPinned && (
            <Box key="header" position="absolute" left={0} right={1} top={offset} flexDirection="column">
              <Box position="absolute" left={0} top={0} flexDirection="column">
                {Array.from({ length: header.rows }, (_, row) => (
                  <Text key={`header-blank-${row}`}>{' '.repeat(columns)}</Text>
                ))}
              </Box>
              {header.node}
              <Text key="header-rule" dimColor>
                {'─'.repeat(columns)}
              </Text>
            </Box>
          )}
          {thumb && (
            <Box key="scrollbar" position="absolute" right={0} top={offset} height={bodyRows} flexDirection="column">
              {Array.from({ length: bodyRows }, (_, row) =>
                row >= thumb.start && row < thumb.start + thumb.size ? (
                  <Text key={`scrollbar-${row}`}>█</Text>
                ) : (
                  <Text key={`scrollbar-${row}`} dimColor>
                    │
                  </Text>
                ),
              )}
            </Box>
          )}
        </Box>
      )
    }

    const marks = await read($, unseen)
    const tasksLabel = tasksLabelOf(source)
    const openAction = current.kind === 'action' ? todo.find(a => a.n === current.n) : undefined
    const section = sectionOf(current)
    const entries = [
      { section: 'questions' as const, label: `❓ Questions (${list.length})` },
      { section: 'actions' as const, label: `🛠 Actions (${todo.length})` },
      { section: 'tasks' as const, label: `📋 Tasks${tasksLabel === '' ? '' : tasksLabel === 'set up' ? ' (set up)' : ` ${tasksLabel}`}` },
    ].map(entry => ({
        ...entry,
        text: `${entry.section === section ? '▸ ' : ''}${entry.label}${marks[entry.section] ? ' (new)' : ''}`,
      }))

    const nav = (
      <Box key="nav" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {entries.map(entry => (
          <Button key={`nav-${entry.section}`} plain onPress={() => void openSection($, entry.section)}>
            <Text bold={entry.section === section} color={entry.section === section ? 'suggestion' : undefined}>
              {entry.text}
            </Text>
          </Button>
        ))}
      </Box>
    )
    const navRows = navRowsOf(
      entries.map(entry => entry.text),
      columns,
    )
    const page = (key: string, estimate: number, content: RenderNode) =>
      withScrollbar(
        `${key}:nav:${entries.map(entry => entry.text).join('|')}`,
        stackRows([navRows, estimate]),
        content,
        { rows: navRows, node: nav },
      )

    if (section === 'tasks' && source.exists) {
      const notice = source.isTooLarge
        ? `${source.path} is larger than 4 MiB, so it is not shown.`
        : source.text === ''
          ? `${source.path} is empty.`
          : undefined
      return page(
        `tasks:${source.hash}:${source.isTooLarge ? 'large' : ''}`,
        stackRows([rowsOf(source.path, columns), rowsOf(notice ?? source.text, columns)]),
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{source.path}</Text>
          {notice === undefined ? <Markdown text={source.text} /> : <Text dimColor>{notice}</Text>}
        </Box>,
      )
    }

    if (section === 'tasks' && !needsTasksSetup(source)) {
      const isDismissed = source.isDismissed && source.isConfirmed !== true
      const notice = isDismissed
        ? 'No tasks file in this session.'
        : `No tasks yet. The agent keeps its task list in ${source.path}; it shows here once the file exists.`
      return page(
        `tasks-none:${isDismissed ? 'dismissed' : source.path}`,
        stackRows([rowsOf(notice, columns), 1]),
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{notice}</Text>
          <Button key="tasks-change" onPress={() => void reopenTasksSetup($)}>
            {isDismissed ? 'Set a path' : 'Change path'}
          </Button>
        </Box>,
      )
    }

    if (section === 'tasks') {
      const prompt = `There is no tasks file at ${source.path}. Where does the agent keep its task list?`
      return page(
        `tasks-setup:${source.path}`,
        stackRows([rowsOf(prompt, columns), 3, 1]),
        <Box flexDirection="column" gap={1}>
          <Text>{prompt}</Text>
          <Input
            key="tasks-path"
            label="Tasks file"
            placeholder="A path, relative to the project or absolute"
            value={source.draft}
            submitLabel="use"
            onInput={value => void update($, tasks, t => ({ ...t, draft: value }))}
            onSubmit={value => void chooseTasksPath($, sound, value)}
          />
          <Box flexDirection="row" gap={1}>
            <Button
              key="tasks-use"
              variant="primary"
              onPress={async () => {
                const { draft } = await read($, tasks)
                await chooseTasksPath($, sound, draft)
              }}
            >
              Use this path
            </Button>
            <Button key="tasks-dismiss" onPress={() => void dismissTasksSetup($)}>
              Not this session
            </Button>
          </Box>
        </Box>,
      )
    }

    if (section === 'actions') {
      if (!openAction && todo.length === 0) {
        return page('actions:none', 1, <Text dimColor>No actions pending.</Text>)
      }
      if (openAction) {
        const n = openAction.n
        return page(
          `a:${n}:${openAction.queuedAt ? 'sent' : 'open'}`,
          actionDetailRows(openAction, at, columns),
          <Box flexDirection="column" gap={1}>
            <Button key="back-actions" plain onPress={() => void openSection($, 'actions')}>
              ← All actions
            </Button>
            <Box flexDirection="column">
              <Text bold>
                A{n} · asked {stampOf(openAction.askedAt)} <Text dimColor>· {ageOf(openAction.askedAt, at)}</Text>
              </Text>
              <Text>{openAction.action}</Text>
            </Box>
            {openAction.context !== '' && <Text dimColor>{openAction.context}</Text>}
            {openAction.url && <Text color="suggestion">{openAction.url}</Text>}
            {openAction.queuedAt ? (
              <Text color="warning">{doneLineOf(openAction.queuedAt)}</Text>
            ) : (
              <Button key="action-done" variant="primary" onPress={() => void markDone($, n)}>
                Done
              </Button>
            )}
          </Box>,
        )
      }
      return page(
        `actions:${todo.map(a => `${a.n}${a.queuedAt ? 's' : ''}`).join(',')}`,
        actionListRows(todo, at, columns),
        <Box flexDirection="column" gap={1}>
            {[...todo]
              .sort((a, b) => a.askedAt.localeCompare(b.askedAt))
              .map(a => (
                <Box flexDirection="column">
                  <Text>
                    A{a.n} · {clockOf(a.askedAt)}{' '}
                    <Text dimColor>
                      · {ageOf(a.askedAt, at)}
                      {a.queuedAt ? ' · ⏳ queued' : ''}
                    </Text>
                  </Text>
                  <Button key={`a-${a.n}`} plain onPress={() => void update($, view, () => ({ kind: 'action', n: a.n }) as View)}>
                    <Text wrap="wrap">{a.action}</Text>
                  </Button>
                </Box>
              ))}
        </Box>,
      )
    }

    if (open) {
      const n = open.n
      return page(
        `q:${n}:${open.queuedAt ? 'sent' : 'open'}`,
        detailRows(open, at, columns),
        <Box flexDirection="column" gap={1}>
          <Button key="back" plain onPress={() => void openSection($, 'questions')}>
            ← All questions
          </Button>
          <Box flexDirection="column">
            <Text bold>
              Q{n} · asked {stampOf(open.askedAt)} <Text dimColor>· {ageOf(open.askedAt, at)}</Text>
            </Text>
            <Text>{open.question}</Text>
          </Box>
          {open.context !== '' && <Text dimColor>{open.context}</Text>}
          {open.options.length > 0 && (
            <Box flexDirection="column">
              {open.options.map(o => {
                const isSelected = open.draft === optionTextOf(o)
                return (
                  <Button key={`option-${o.key}`} plain onPress={() => void setDraft($, n, optionTextOf(o))}>
                    <Text color={isSelected ? 'suggestion' : undefined} bold={isSelected}>
                      {isSelected ? '● ' : '○ '}
                      {optionTextOf(o)}
                    </Text>
                    {o.key === open.recommended ? <Text color="success"> (recommended)</Text> : ''}
                  </Button>
                )
              })}
            </Box>
          )}
          {open.queuedAt ? (
            <Text color="warning">{sentLineOf(open.queuedAt)}</Text>
          ) : (
            <Box flexDirection="column">
              <Input
                key={`answer-${n}`}
                label="Answer"
                placeholder="Pick an option or write your answer"
                rows={4}
                value={open.draft ?? ''}
                submitLabel="send"
                autoFocus
                onInput={value => void setDraft($, n, value)}
                onSubmit={value => void send($, n, value)}
              />
              <Box flexDirection="row" gap={1}>
                <Button
                  key="send"
                  variant="primary"
                  onPress={async () => {
                    const q = (await read($, questions)).find(one => one.n === n)
                    await send($, n, q?.draft ?? '')
                  }}
                >
                  Send
                </Button>
                <Button
                  key="send-through-chat"
                  onPress={async () => {
                    const q = (await read($, questions)).find(one => one.n === n)
                    await sendThroughChat($, n, q?.draft ?? '')
                  }}
                >
                  Send now (to chat)
                </Button>
              </Box>
            </Box>
          )}
        </Box>,
      )
    }

    if (list.length === 0) {
      return page('list:none', 1, <Text dimColor>No questions pending.</Text>)
    }
    const showDays = spansDays(list, at)
    return page(
      `list:${showDays ? 'days' : 'today'}:${list.map(q => `${q.n}${q.queuedAt ? 's' : ''}`).join(',')}`,
      listRows(list, at, columns),
      <Box flexDirection="column" gap={1}>
        {groupByDay(list, at).map(group => (
          <Box flexDirection="column" gap={1}>
            {showDays && <Text dimColor>── {group.label} ──</Text>}
            {group.items.map(q => (
              <Box flexDirection="column">
                <Text>
                  Q{q.n} · {clockOf(q.askedAt)}{' '}
                  <Text dimColor>
                    · {ageOf(q.askedAt, at)}
                    {q.queuedAt ? ' · ⏳ queued' : ''}
                  </Text>
                </Text>
                <Button key={`q-${q.n}`} plain onPress={() => void update($, view, () => ({ kind: 'question', n: q.n }) as View)}>
                  <Text wrap="wrap">{q.question}</Text>
                </Button>
              </Box>
            ))}
          </Box>
        ))}
      </Box>,
    )
  })
}
