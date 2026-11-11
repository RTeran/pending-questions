import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Option, Question, View } from '../types'

const PANE = 'pending-questions'
const TITLE = 'Preguntas pendientes'
const OPEN_TOOL = 'mcp__pending-questions__question_open'
const CLOSE_TOOL = 'mcp__pending-questions__question_close'
const LOCALE = 'es-ES'

const questions = atom({ plugin: 'pending-questions', key: 'questions' } as const, [] as Question[], {
  shape: 'questions-1',
})
const view = atom({ plugin: 'pending-questions', key: 'view' } as const, { kind: 'list' } as View, {
  shape: 'view-1',
})
const LIST: View = { kind: 'list' }

const now = atom({ plugin: 'pending-questions', key: 'now' } as const, '')

const pad = (n: number) => String(n).padStart(2, '0')

const dayOf = (t: Date) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`

export const clockOf = (iso: string) => {
  const t = new Date(iso)
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`
}

export const stampOf = (iso: string) => {
  const t = new Date(iso)
  return `${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()} ${clockOf(iso)}`
}

export const ageOf = (iso: string, at: Date) => {
  const minutes = Math.floor((at.getTime() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `hace ${minutes} min`
  if (minutes < 24 * 60) return `hace ${Math.floor(minutes / 60)} h`
  return `hace ${Math.floor(minutes / (24 * 60))} d`
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export const dayLabelOf = (iso: string, at: Date) => {
  const t = new Date(iso)
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(at) - midnight(t)) / 86_400_000)
  if (days === 0) return 'Hoy'
  if (days === 1) return 'Ayer'
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

export const answerTextOf = (q: Question, answer: string) => `[Q${q.n} · preguntada ${stampOf(q.askedAt)}] ${answer.trim()}`

export const answeredRef = (text: string) => {
  const match = /^\s*\[Q(\d+)\b/.exec(text)
  return match ? Number(match[1]) : undefined
}

export const optionTextOf = (o: Option) => `${o.key}: ${o.label}`

const ANSWER_ORIGINS =new Set(['composer', 'bridge', 'plugin'])

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

type OpenInput = { question?: unknown; context?: unknown; options?: unknown; recommended?: unknown }
type CloseInput = { n?: unknown; reason?: unknown }

let storeKey = 'open'
let seqKey = 'seq'

async function save($: Engine) {
  const list = await read($, questions)
  await $.store.set(storeKey, list)
  $.ui.status(list.length === 0 ? undefined : `❓ ${list.length} ${list.length === 1 ? 'pregunta pendiente' : 'preguntas pendientes'} · /preguntas`)
}

async function resolveQuestion($: Engine, n: number) {
  const list = await read($, questions)
  if (!list.some(q => q.n === n)) return
  await update($, questions, all => all.filter(q => q.n !== n))
  await update($, view, current => (current.kind === 'question' && current.n === n ? LIST : current))
  await save($)
  $.ui.toast(`Q${n} respondida.`)
}

function setDraft($: Engine, n: number, draft: string) {
  return update($, questions, all => all.map(q => (q.n === n ? { ...q, draft } : q)))
}

async function send($: Engine, n: number, raw: string) {
  const answer = raw.trim()
  const q = (await read($, questions)).find(one => one.n === n)
  if (!q || q.queuedAt) return
  if (answer === '') {
    $.ui.toast('Escribe una respuesta o elige una opción antes de enviar.')
    return
  }
  await update($, questions, all =>
    all.map(one => (one.n === n ? { ...one, draft: answer, queuedAt: new Date().toISOString() } : one)),
  )
  await update($, view, () => LIST)
  await save($)
  void $.prompt
    .submit({ text: answerTextOf(q, answer), asUser: true })
    .then(() => resolveQuestion($, n))
    .catch(async () => {
      await update($, questions, all => all.map(one => (one.n === n ? { ...one, queuedAt: undefined } : one)))
      await save($)
      $.ui.toast(`No se pudo enviar la respuesta a Q${n}. Sigue pendiente.`)
    })
}

async function sendThroughChat($: Engine, n: number, raw: string) {
  const q = (await read($, questions)).find(one => one.n === n)
  if (!q) return
  const { text: typed } = await $.prompt.read()
  const text = answerTextOf(q, raw)
  await $.prompt.fill(typed.trim() === '' ? { text, mode: 'replace' } : { text: `\n\n${text}`, mode: 'append' })
  await update($, view, () => LIST)
  $.ui.toast(`Respuesta a Q${n} en el prompt: pulsa Enter para enviarla.`)
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

export async function isTeammateProcess($: Engine) {
  try {
    const { stdout } = await $.process.run(['/bin/sh', '-c', TEAMMATE_PROBE], { timeoutMs: 3000 })
    return stdout.trim() === 'teammate'
  } catch {
    return false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (await isTeammateProcess($)) return next(e)

    const sessionId = await $.session.id()
    storeKey = `open:${sessionId}`
    seqKey = `seq:${sessionId}`

    await $.tool.register({
      name: 'question_open',
      description: [
        'Register a question for the human in the "pending questions" side pane.',
        'Call it for every decision you need from the human, then keep working on whatever does not depend on the answer.',
        'The pane keeps the question, with the date and time it was asked, until the human answers.',
        'The answer arrives as a user message starting with "[Q<n> · preguntada <date>]"; it may arrive while you are busy with something else.',
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

    await $.command.register({ name: 'preguntas', description: 'Abre el panel de preguntas pendientes' })

    if ((await read($, questions)).length === 0) {
      const stored = await $.store.get(storeKey)
      if (isQuestionList(stored) && stored.length > 0) {
        await update($, questions, () => stored.map(({ queuedAt: _, ...q }) => q))
      }
    }
    await update($, now, () => new Date().toISOString())
    $.clock.every(60_000, () => void update($, now, () => new Date().toISOString()))
    await save($)

    return next(e)
  })

  on('command.run', { command: 'preguntas' }, async $ => {
    await update($, view, () => LIST)
    await $.ui.open({ id: PANE, title: TITLE })
    const count = (await read($, questions)).length
    return { text: count === 0 ? 'No hay preguntas pendientes.' : `Panel abierto: ${count} pendientes.` }
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

    const n = Number((await $.store.get(seqKey)) ?? 0) + 1
    await $.store.set(seqKey, n)
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
    void $.ui.open({ id: PANE, title: TITLE })

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

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const n = e.command || !ANSWER_ORIGINS.has(e.origin.kind) ? undefined : answeredRef(e.text)
    if (n !== undefined) await resolveQuestion($, n)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, questions)
    const current = await read($, view)
    const stamp = await read($, now)
    const at = stamp ? new Date(stamp) : new Date()

    const open = current.kind === 'question' ? list.find(q => q.n === current.n) : undefined

    if (open) {
      const n = open.n
      return (
        <Box flexDirection="column" gap={1}>
          <Button key="back" plain onPress={() => void update($, view, () => LIST)}>
            ← Todas las preguntas
          </Button>
          <Box flexDirection="column">
            <Text bold>
              Q{n} · preguntada {stampOf(open.askedAt)} <Text dimColor>· {ageOf(open.askedAt, at)}</Text>
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
                    {o.key === open.recommended ? <Text color="success"> (recomendada)</Text> : ''}
                  </Button>
                )
              })}
            </Box>
          )}
          {open.queuedAt ? (
            <Text color="warning">⏳ Enviada a las {clockOf(open.queuedAt)}: llegará cuando el lead termine su turno.</Text>
          ) : (
            <Box flexDirection="column">
              <Input
                key={`answer-${n}`}
                label="Respuesta"
                placeholder="Elige una opción o escribe tu respuesta"
                rows={4}
                value={open.draft ?? ''}
                submitLabel="enviar"
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
                  Enviar
                </Button>
                <Button
                  key="send-through-chat"
                  onPress={async () => {
                    const q = (await read($, questions)).find(one => one.n === n)
                    await sendThroughChat($, n, q?.draft ?? '')
                  }}
                >
                  Enviar ya (al chat)
                </Button>
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    if (list.length === 0) return <Text dimColor>No hay preguntas pendientes.</Text>

    const showDays = spansDays(list, at)
    return (
      <Box flexDirection="column" gap={1}>
        {groupByDay(list, at).map(group => (
          <Box flexDirection="column" gap={1}>
            {showDays && <Text dimColor>── {group.label} ──</Text>}
            {group.items.map(q => (
              <Box flexDirection="column">
                <Button key={`q-${q.n}`} plain onPress={() => void update($, view, () => ({ kind: 'question', n: q.n }) as View)}>
                  Q{q.n} · {clockOf(q.askedAt)}{' '}
                  <Text dimColor>
                    · {ageOf(q.askedAt, at)}
                    {q.queuedAt ? ' · ⏳ en cola' : ''}
                  </Text>
                </Button>
                <Text>{q.question}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
