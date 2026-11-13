import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { answeredRef, answerTextOf, dayLabelOf, groupByDay, spansDays } from '../hooks/register'
import type { Question } from '../types'

const OPEN = 'mcp__pending-questions__question_open'
const CLOSE = 'mcp__pending-questions__question_close'

const PANE = {
  plugin: 'pending-questions',
  component: 'Pane',
  requestId: 'pending-questions',
  surface: 'terminal',
  props: {
    title: 'Preguntas pendientes',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const engine = (on: On, stored: Record<string, unknown> = {}, probe = 'main\n') => {
  const submitted: string[] = []
  const tools: string[] = []
  const commands: string[] = []
  on('process.run', () => ({
    value: { exitCode: 0, stdout: probe, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  mock.store(on, stored)
  on('session.id', () => ({ value: 'session-1' }))
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', (_, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => {
    tools.push(e.name)
    return { value: { tool: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { submitted, clock, tools, commands }
}

const question = (n: number, askedAt: string): Question => ({ n, question: `q${n}`, context: '', options: [], askedAt })

describe('helpers', () => {
  const at = new Date(2026, 10, 11, 12, 0)

  test('day labels read like a messaging app', async () => {
    expect(dayLabelOf(new Date(2026, 10, 11, 9).toISOString(), at)).toBe('Hoy')
    expect(dayLabelOf(new Date(2026, 10, 10, 23).toISOString(), at)).toBe('Ayer')
    expect(dayLabelOf(new Date(2026, 10, 9, 9).toISOString(), at)).toBe('Lunes')
    expect(dayLabelOf(new Date(2026, 9, 1, 9).toISOString(), at)).toMatch(/1 de octubre/)
  })

  test('days are separated only when a question is older than today', async () => {
    const today = question(2, new Date(2026, 10, 11, 10).toISOString())
    const yesterday = question(1, new Date(2026, 10, 10, 18).toISOString())
    expect(spansDays([today], at)).toBe(false)
    expect(spansDays([today, yesterday], at)).toBe(true)
    expect(groupByDay([today, yesterday], at).map(g => g.label)).toEqual(['Ayer', 'Hoy'])
  })

  test('an answer carries when its question was asked', async () => {
    const q = question(3, new Date(2026, 10, 11, 10, 42).toISOString())
    expect(answerTextOf(q, ' B: yes ')).toBe('[Q3 · preguntada 11/11/2026 10:42] B: yes')
    expect(answeredRef('[Q3 · preguntada 11/11/2026 10:42] B')).toBe(3)
    expect(answeredRef('  [Q12] ok')).toBe(12)
    expect(answeredRef('see Q3')).toBeUndefined()
  })
})

test('/questions opens the pane', async ($, on) => {
  const { commands } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(commands).toEqual(['questions'])

  const ran = await $.command.run({ command: 'questions' })
  expect(ran.text).toBe('No hay preguntas pendientes.')
})

test('a question is answered from the pane and leaves it', async ($, on) => {
  const { submitted, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const opened = await $.tool.call({
    tool: OPEN,
    question: '¿Añado la dependencia X?',
    context: 'Hace falta para parsear fechas.',
    options: [{ label: 'Sí' }, { label: 'No' }],
    recommended: 'B',
  })
  expect(String(opened.result)).toMatch(/^Registered as Q1, asked /)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /Añado la dependencia/ }))?.text).toBe('¿Añado la dependencia X?')

  await ui.press({ key: 'q-1' })
  expect((await ui.find({ type: 'Text', text: /Hace falta/ }))?.text).toBe('Hace falta para parsear fechas.')

  await ui.press({ key: 'option-B' })
  await ui.input({ key: 'answer-1', text: 'B: No, usa Intl', kind: 'submit' })
  await clock.settle()

  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^\[Q1 · preguntada \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\] B: No, usa Intl$/)
  expect((await ui.find({ type: 'Text', text: /No hay preguntas/ }))?.text).toBe('No hay preguntas pendientes.')
  await ui.unmount()
})

test('the list opens a question from its title, not from its date', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: OPEN, question: '¿Borro la rama vieja?' })

  const ui = await $.ui.mount(PANE)
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.key).toBe('q-1')
  expect(buttons[0]?.text).toBe('¿Borro la rama vieja?')
  expect(await ui.find({ type: 'Button', text: /\d{2}:\d{2}/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Q1 · \d{2}:\d{2}/ })).toBeDefined()

  await ui.press({ key: 'q-1' })
  expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()
  await ui.unmount()
})

test('an answer typed in the chat closes its question', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: OPEN, question: 'one' })
  await $.tool.call({ tool: OPEN, question: 'two' })

  await $.prompt.submit({ text: '[Q1 · preguntada 11/11/2026 10:42] vale', wait: false, origin: { kind: 'composer' } })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', text: /^one$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', text: /^two$/ }))?.text).toBe('two')
  await ui.unmount()
})

test('numbers are never reused after a question is closed', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: OPEN, question: 'one' })
  const closed = await $.tool.call({ tool: CLOSE, n: 1 })
  expect(String(closed.result)).toBe('Q1 removed from the pane.')

  const next = await $.tool.call({ tool: OPEN, question: 'two' })
  expect(String(next.result)).toMatch(/^Registered as Q2,/)
})

test('a subagent cannot register a question', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const denied = await $.tool.call({ tool: OPEN, question: 'mine', agentId: 'impl-1' })
  expect(denied.deny).toMatch(/never call this/)
})

test('a restart forgets an answer that was only queued, so it can be sent again', async ($, on) => {
  const asked = new Date(2026, 10, 10, 18).toISOString()
  engine(on, {
    'open:session-1': [{ ...question(4, asked), queuedAt: asked }],
    'seq:session-1': 4,
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /en cola/ })).toBeUndefined()
  await ui.press({ key: 'q-4' })
  expect(await ui.find({ type: 'Input', key: 'answer-4' })).toBeDefined()
  await ui.unmount()
})

test('a message from a peer does not close a question', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: OPEN, question: 'one' })

  await $.prompt.submit({ text: '[Q1] from a peer', wait: false, origin: { kind: 'peer' } as never })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /^one$/ }))?.text).toBe('one')
  await ui.unmount()
})

test('a teammate in a pane of its own gets none of the tools', async ($, on) => {
  const { tools } = engine(on, {}, 'teammate\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(tools).toEqual([])
})

test('the main session and the lead get both tools', async ($, on) => {
  const { tools } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(tools).toEqual(['question_open', 'question_close'])
})

test('a picked option stays marked until the answer changes or another is picked', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: OPEN, question: 'pick', options: [{ label: 'Sí' }, { label: 'No' }] })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'q-1' })
  expect(await ui.find({ type: 'Text', text: /^● / })).toBeUndefined()

  await ui.press({ key: 'option-A' })
  expect((await ui.find({ type: 'Text', text: /^● / }))?.text).toBe('● A: Sí')

  await ui.press({ key: 'option-B' })
  expect((await ui.find({ type: 'Text', text: /^● / }))?.text).toBe('● B: No')

  await ui.input({ key: 'answer-1', text: 'B: No, pero luego', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^● / })).toBeUndefined()
  await ui.unmount()
})
