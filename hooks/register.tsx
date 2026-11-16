import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, RenderNode } from 'claude-code'

import type { Action, Option, Question, ScrollCache, TasksSource, View } from '../types'

const PANE = 'pending-questions'
const TITLE = 'Pending questions'
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
const ACTIONS: View = { kind: 'actions' }

const NO_TASKS: TasksSource = {
  path: '',
  exists: false,
  text: '',
  hash: '',
  isTooLarge: false,
  draft: '',
  isDismissed: false,
  isSetupAsked: false,
}
const tasks = atom({ plugin: 'pending-questions', key: 'tasks' } as const, NO_TASKS, { shape: 'tasks-1' })
const TASKS_VIEW: View = { kind: 'tasks' }

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

const outlineOf = (text: string) => {
  const items = new Map<string, boolean>()
  const headings = new Set<string>()
  for (const line of normalize(text).split('\n')) {
    const item = CHECKBOX.exec(line)
    if (item) {
      const label = item[2]?.trim() ?? ''
      if (!items.has(label)) items.set(label, item[1] !== ' ')
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) headings.add(heading[1]?.trim() ?? '')
  }
  return { items, headings }
}

export type TasksChange = { done: number; reopened: number; added: number; sections: number; isNotable: boolean; text: string }

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
  const counts = ([
    [done, 'done'],
    [reopened, 'reopened'],
    [added, 'added'],
  ] as const).filter(([count]) => count > 0)
  const all = [
    ...counts.map(([count, word], i) => (i === 0 ? `${countOf(count, 'task', 'tasks')} ${word}` : `${count} ${word}`)),
    ...(sections > 0 ? [countOf(sections, 'new section', 'new sections')] : []),
  ]
  return { done, reopened, added, sections, isNotable: all.length > 0, text: all.join(', ') }
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

export type SoundGate = 'inbox' | 'tasks'

const SOUND_GAP_MS: Record<SoundGate, number> = { inbox: 1_000, tasks: 60_000 }
const lastSoundAt: Record<SoundGate, number> = { inbox: -Infinity, tasks: -Infinity }

const logDebug = ($: Engine, text: string) => {
  try {
    $.ui.log(`pending-questions: ${text}`, { to: 'debug' })
  } catch {
    // A sound is a courtesy: losing its log line must not fail the question.
  }
}

const logSoundFailure = ($: Engine, error: unknown) => logDebug($, `the new-question sound did not play: ${String(error)}`)

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
  gate: SoundGate = 'inbox',
): Promise<{ played: Promise<void> | undefined }> {
  if (sound === 'off') return { played: undefined }
  try {
    const at = await $.clock.now()
    if (at - lastSoundAt[gate] < SOUND_GAP_MS[gate]) return { played: undefined }
    lastSoundAt[gate] = at
  } catch (error) {
    logSoundFailure($, error)
    return { played: undefined }
  }
  const played = Promise.resolve()
    .then(() => (sound === 'alert' ? playAlert($) : $.audio.play(ACK_SOUND)))
    .catch(error => logSoundFailure($, error))
  return { played }
}

type OpenInput = { question?: unknown; context?: unknown; options?: unknown; recommended?: unknown }
type CloseInput = { n?: unknown; reason?: unknown }
type ActionOpenInput = { action?: unknown; context?: unknown; url?: unknown }

// A /clear gives the process a new session id without a session.start. The store keys stay
// on the id the chain started with, so open items and their numbering outlive the /clear;
// the alias lets a reload whose $.state was lost find that id again.
const chain = atom({ plugin: 'pending-questions', key: 'chain' } as const, '')
let chainId = ''
let seenId = ''

async function keysOf($: Engine) {
  const id = await $.session.id()
  if (chainId === '') {
    const alias = await $.store.get(`alias:${id}`)
    chainId = (await read($, chain)) || (typeof alias === 'string' && alias !== '' ? alias : id)
    await update($, chain, () => chainId)
  }
  if (id !== seenId) {
    seenId = id
    if (id !== chainId) await $.store.set(`alias:${id}`, chainId)
  }
  return {
    open: `open:${chainId}`,
    seq: `seq:${chainId}`,
    actions: `actions:${chainId}`,
    actionSeq: `aseq:${chainId}`,
  }
}

const countOf = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

async function save($: Engine) {
  const list = await read($, questions)
  const todo = await read($, actions)
  const keys = await keysOf($)
  await $.store.set(keys.open, list)
  await $.store.set(keys.actions, todo)
  const parts = [
    ...(list.length > 0 ? [`❓ ${countOf(list.length, 'pending question', 'pending questions')}`] : []),
    ...(todo.length > 0 ? [`🛠 ${countOf(todo.length, 'pending action', 'pending actions')}`] : []),
  ]
  $.ui.status(parts.length === 0 ? undefined : `${parts.join(' · ')} · /questions`)
}

function openPane($: Engine) {
  Promise.resolve()
    .then(() => $.ui.open({ id: PANE, title: TITLE }))
    .catch(error => logDebug($, `the pane did not open: ${String(error)}`))
}

async function announce($: Engine, sound: Sound) {
  try {
    await chime($, sound)
  } catch (error) {
    logSoundFailure($, error)
  }
  openPane($)
}

async function removeAction($: Engine, n: number) {
  let isRemoved = false
  await update($, actions, all => {
    isRemoved = all.some(a => a.n === n)
    return isRemoved ? all.filter(a => a.n !== n) : all
  })
  if (!isRemoved) return false
  await update($, view, current => (current.kind === 'action' && current.n === n ? ACTIONS : current))
  await save($)
  return true
}

async function resolveAction($: Engine, n: number) {
  if (await removeAction($, n)) $.ui.toast(`A${n} done.`)
}

async function markDone($: Engine, n: number) {
  try {
    await markDoneOrThrow($, n)
  } catch (error) {
    logDebug($, `A${n} could not be marked done: ${String(error)}`)
    await unqueueAction($, n)
    $.ui.toast(`Could not mark A${n} as done. It is still pending.`)
  }
}

async function unqueueAction($: Engine, n: number) {
  try {
    await update($, actions, all => all.map(one => (one.n === n ? { ...one, queuedAt: undefined } : one)))
    await save($)
  } catch (error) {
    logDebug($, `A${n} could not be put back as pending: ${String(error)}`)
  }
}

async function markDoneOrThrow($: Engine, n: number) {
  const a = (await read($, actions)).find(one => one.n === n)
  if (!a || a.queuedAt) return
  await update($, actions, all => all.map(one => (one.n === n ? { ...one, queuedAt: new Date().toISOString() } : one)))
  await update($, view, () => ACTIONS)
  await save($)
  try {
    await $.prompt.submit({ text: doneTextOf(n), asUser: true })
  } catch (error) {
    logDebug($, `A${n} could not be marked done: ${String(error)}`)
    await unqueueAction($, n)
    $.ui.toast(`Could not mark A${n} as done. It is still pending.`)
    return
  }
  try {
    await resolveAction($, n)
  } catch (error) {
    logDebug($, `A${n} was marked done but the pane did not catch up: ${String(error)}`)
  }
}

async function resolveQuestion($: Engine, n: number) {
  let isRemoved = false
  await update($, questions, all => {
    isRemoved = all.some(q => q.n === n)
    return isRemoved ? all.filter(q => q.n !== n) : all
  })
  if (!isRemoved) return
  await update($, view, current => (current.kind === 'question' && current.n === n ? LIST : current))
  await save($)
  $.ui.toast(`Q${n} answered.`)
}

function setDraft($: Engine, n: number, draft: string) {
  return update($, questions, all => all.map(q => (q.n === n ? { ...q, draft } : q)))
}

async function send($: Engine, n: number, raw: string) {
  try {
    await sendOrThrow($, n, raw)
  } catch (error) {
    logDebug($, `the answer to Q${n} could not be sent: ${String(error)}`)
    await unqueueQuestion($, n)
    $.ui.toast(`Could not send the answer to Q${n}. It is still pending.`)
  }
}

async function unqueueQuestion($: Engine, n: number) {
  try {
    await update($, questions, all => all.map(one => (one.n === n ? { ...one, queuedAt: undefined } : one)))
    await save($)
  } catch (error) {
    logDebug($, `Q${n} could not be put back as pending: ${String(error)}`)
  }
}

async function sendOrThrow($: Engine, n: number, raw: string) {
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
  await update($, view, () => LIST)
  await save($)
  try {
    await $.prompt.submit({ text: answerTextOf(q, answer), asUser: true })
  } catch (error) {
    logDebug($, `the answer to Q${n} could not be sent: ${String(error)}`)
    await unqueueQuestion($, n)
    $.ui.toast(`Could not send the answer to Q${n}. It is still pending.`)
    return
  }
  try {
    await resolveQuestion($, n)
  } catch (error) {
    logDebug($, `the answer to Q${n} was sent but the pane did not catch up: ${String(error)}`)
  }
}

async function sendThroughChat($: Engine, n: number, raw: string) {
  const q = (await read($, questions)).find(one => one.n === n)
  if (!q) return
  const { text: typed } = await $.prompt.read()
  const text = answerTextOf(q, raw)
  await $.prompt.fill(typed.trim() === '' ? { text, mode: 'replace' } : { text: `\n\n${text}`, mode: 'append' })
  await update($, view, () => LIST)
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

export const tasksInstructionOf = (path: string) =>
  `Keep your task list in ${path}, using \`- [ ]\` / \`- [x]\` checkboxes.`

const absoluteOf = (path: string, root: string) => (path.startsWith('/') ? path : `${root.replace(/\/+$/, '')}/${path}`)

let isLead = false
let tasksRoot = ''
let tasksPath = ''
let lastStat = ''
let current: Snapshot = { hash: hashOf(''), text: '' }
let committed: Snapshot | undefined
let pending = { hash: '', count: 0 }
let polling: { cancel: () => void } | undefined
let observing: Promise<void> = Promise.resolve()

async function readTasks($: Engine) {
  let stat: { size: number; mtimeMs: number; kind: string } | undefined
  try {
    stat = await $.fs.stat(tasksPath)
  } catch {
    stat = undefined
  }
  if (!stat || stat.kind !== 'file') {
    lastStat = ''
    current = { hash: hashOf(''), text: '' }
    await update($, tasks, t => ({ ...t, exists: false, text: '', hash: '', isTooLarge: false }))
    return
  }
  const key = `${stat.size}:${stat.mtimeMs}`
  if (key === lastStat) return
  const isTooLarge = stat.size > TASKS_MAX_BYTES
  const raw = isTooLarge ? '' : await $.fs.read(tasksPath)
  const text = normalize(typeof raw === 'string' ? raw : '')
  lastStat = key
  current = { hash: hashOf(text), text }
  await update($, tasks, t => ({ ...t, exists: true, text, hash: current.hash, isTooLarge }))
}

async function commit($: Engine, next: Snapshot) {
  committed = next
  pending = { hash: '', count: 0 }
  await $.store.set(`tasksSeen:${tasksRoot}`, { path: tasksPath, ...next } satisfies Seen)
}

async function notifyTasks($: Engine, sound: Sound, text: string) {
  await chime($, sound, 'tasks')
  await update($, view, () => TASKS_VIEW)
  openPane($)
  $.ui.toast(text)
}

async function observeTasks($: Engine, sound: Sound, isPoll: boolean) {
  await readTasks($)
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
  if (change.isNotable) await notifyTasks($, sound, change.text)
}

function observe($: Engine, sound: Sound, isPoll: boolean) {
  observing = observing
    .then(() => observeTasks($, sound, isPoll))
    .catch(error => logDebug($, `the tasks file could not be read: ${String(error)}`))
  return observing
}

async function chooseTasksPath($: Engine, sound: Sound, raw: string) {
  const typed = raw.trim()
  if (typed === '') {
    $.ui.toast('Write the path of the tasks file first.')
    return
  }
  const path = absoluteOf(typed, tasksRoot)
  await $.store.set(`tasksFile:${tasksRoot}`, path)
  await update($, view, () => TASKS_VIEW)
  await useTasksPath($, sound, path)
}

async function dismissTasksSetup($: Engine) {
  await update($, tasks, t => ({ ...t, isDismissed: true }))
  await update($, view, () => LIST)
}

async function refreshOnWrite($: Engine, sound: Sound, filePath: unknown) {
  try {
    if (isLead && typeof filePath === 'string' && absoluteOf(filePath, tasksRoot) === tasksPath) await observe($, sound, false)
  } catch {
    // A refresh is a courtesy: it must never change what the Write or Edit answered.
  }
}

async function useTasksPath($: Engine, sound: Sound, path: string) {
  tasksPath = path
  lastStat = ''
  committed = undefined
  pending = { hash: '', count: 0 }
  const seen = await $.store.get(`tasksSeen:${tasksRoot}`)
  if (isSeenFor(seen, path)) committed = { hash: seen.hash, text: seen.text }
  await update($, tasks, t => ({ ...t, path, draft: path }))
  await observe($, sound, true)
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
    const keys = await keysOf($)

    await $.tool.register({
      name: 'question_open',
      description: [
        'Register a question or a decision for the human in the "pending questions" side pane.',
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
        'Register an action for the human in the "pending questions" side pane: something only the human can do outside the chat, such as merging a pull request, testing something by hand or providing a credential.',
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
        'Remove a pending action from the side pane without it being done, because it no longer matters. Actions the human marks done leave the pane by themselves.',
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

    await $.command.register({ name: 'questions', description: 'Opens the pending questions pane' })

    isLead = true
    tasksRoot = await $.session.root()
    const storedPath = await $.store.get(`tasksFile:${tasksRoot}`)
    const optionPath = typeof options.tasksFile === 'string' ? options.tasksFile.trim() : ''
    const path = typeof storedPath === 'string' && storedPath !== '' ? storedPath : optionPath !== '' ? optionPath : 'TASKS.md'
    await useTasksPath($, sound, absoluteOf(path, tasksRoot))
    const source = await read($, tasks)
    if (e.isInteractive && !source.exists && !source.isDismissed && !source.isSetupAsked) {
      await update($, tasks, t => ({ ...t, isSetupAsked: true }))
      await update($, view, () => ({ kind: 'tasks-setup' }) as View)
      await chime($, sound, 'tasks')
      openPane($)
    }
    polling?.cancel()
    polling = $.clock.every(TASKS_POLL_MS, () => void observe($, sound, true))

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
    await update($, now, () => new Date().toISOString())
    $.clock.every(60_000, () => void update($, now, () => new Date().toISOString()))
    await save($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
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
    await update($, view, () => LIST)
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
    await announce($, sound)

    return {
      result: `Registered as Q${n}, asked ${stampOf(askedAt)}. It stays in the human's pane until answered. Refer to it as Q${n}.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pending-questions failed; ask the human in the chat instead.' }))

  on('tool.call', { tool: CLOSE_TOOL }, async ($, e) => {
    const { n } = e as unknown as CloseInput
    const list = await read($, questions)
    if (typeof n !== 'number' || !list.some(q => q.n === n)) return { deny: `There is no pending Q${String(n)}.` }
    await update($, questions, all => all.filter(q => q.n !== n))
    await update($, view, current => (current.kind === 'question' && current.n === n ? LIST : current))
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
    await announce($, sound)

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

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!isLead || tasksPath === '' || e.traits.includes('teammate')) return result
    return { sections: [...result.sections, { id: 'pending-questions:tasks', text: tasksInstructionOf(tasksPath), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.command || !ANSWER_ORIGINS.has(e.origin.kind)) return result
    try {
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

    const withScrollbar = (key: string, estimate: number, content: RenderNode) => {
      drawnKey = `${key}:${columns}`
      const { offset, bodyRows } = e.props.scroll
      const contentRows = cached.key === drawnKey ? cached.contentRows : estimate
      const thumb = thumbOf({ offset, bodyRows, contentRows })
      return (
        <Box flexDirection="column" position="relative" paddingRight={1}>
          {content}
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

    if ((current.kind === 'tasks' || current.kind === 'tasks-setup') && source.exists) {
      const body = source.isTooLarge
        ? `${source.path} is larger than 4 MiB, so it is not shown.`
        : source.text === ''
          ? `${source.path} is empty.`
          : undefined
      return withScrollbar(
        `tasks:${source.hash}:${source.isTooLarge ? 'large' : ''}`,
        stackRows([1, rowsOf(source.path, columns), body === undefined ? rowsOf(source.text, columns) : rowsOf(body, columns)]),
        <Box flexDirection="column" gap={1}>
          <Button key="to-questions" plain onPress={() => void update($, view, () => LIST)}>
            ← Questions ({list.length})
          </Button>
          <Text dimColor>{source.path}</Text>
          {body === undefined ? <Markdown text={source.text} /> : <Text dimColor>{body}</Text>}
        </Box>,
      )
    }

    if (current.kind === 'tasks' || current.kind === 'tasks-setup') {
      drawnKey = ''
      return (
        <Box flexDirection="column" gap={1}>
          <Button key="to-questions" plain onPress={() => void update($, view, () => LIST)}>
            ← Questions ({list.length})
          </Button>
          <Text>There is no tasks file at {source.path}. Where does the agent keep its task list?</Text>
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
        </Box>
      )
    }

    if (current.kind === 'actions' || current.kind === 'action') {
      const openAction = current.kind === 'action' ? todo.find(a => a.n === current.n) : undefined
      if (openAction) {
        const n = openAction.n
        return withScrollbar(
          `a:${n}:${openAction.queuedAt ? 'sent' : 'open'}`,
          actionDetailRows(openAction, at, columns),
          <Box flexDirection="column" gap={1}>
            <Button key="back-actions" plain onPress={() => void update($, view, () => ACTIONS)}>
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
      return withScrollbar(
        `actions:${todo.map(a => `${a.n}${a.queuedAt ? 's' : ''}`).join(',')}`,
        actionListRows(todo, at, columns),
        <Box flexDirection="column" gap={1}>
          <Button key="to-questions" plain onPress={() => void update($, view, () => LIST)}>
            ← Questions ({list.length})
          </Button>
          {todo.length === 0 ? (
            <Text dimColor>No pending actions.</Text>
          ) : (
            [...todo]
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
              ))
          )}
        </Box>,
      )
    }

    if (open) {
      const n = open.n
      return withScrollbar(
        `q:${n}:${open.queuedAt ? 'sent' : 'open'}`,
        detailRows(open, at, columns),
        <Box flexDirection="column" gap={1}>
          <Button key="back" plain onPress={() => void update($, view, () => LIST)}>
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

    const hasTasksEntry = source.exists || (source.path !== '' && !source.isDismissed)
    const toActions =
      todo.length > 0 || hasTasksEntry ? (
        <Box flexDirection="row" gap={2}>
          {todo.length > 0 && (
            <Button key="to-actions" plain onPress={() => void update($, view, () => ACTIONS)}>
              🛠 Actions ({todo.length}) →
            </Button>
          )}
          {hasTasksEntry && (
            <Button key="to-tasks" plain onPress={() => void update($, view, () => TASKS_VIEW)}>
              📋 Tasks →
            </Button>
          )}
        </Box>
      ) : undefined

    if (list.length === 0) {
      drawnKey = ''
      return toActions ? (
        <Box flexDirection="column" gap={1}>
          {toActions}
          <Text dimColor>No pending questions.</Text>
        </Box>
      ) : (
        <Text dimColor>No pending questions.</Text>
      )
    }

    const showDays = spansDays(list, at)
    return withScrollbar(
      `list:${showDays ? 'days' : 'today'}:${toActions ? 'nav:' : ''}${list.map(q => `${q.n}${q.queuedAt ? 's' : ''}`).join(',')}`,
      listRows(list, at, columns) + (toActions ? 2 : 0),
      <Box flexDirection="column" gap={1}>
        {toActions}
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
