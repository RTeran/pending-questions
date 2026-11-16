import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  answeredRef,
  answerTextOf,
  dayLabelOf,
  detailRows,
  groupByDay,
  listRows,
  rowsOf,
  spansDays,
  thumbOf,
} from '../hooks/register'
import type { Question } from '../types'

const OPEN = 'mcp__pending-questions__question_open'
const CLOSE = 'mcp__pending-questions__question_close'

const PANE = {
  plugin: 'pending-questions',
  component: 'Pane',
  requestId: 'pending-questions',
  surface: 'terminal',
  props: {
    title: 'Pending questions',
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
    expect(dayLabelOf(new Date(2026, 10, 11, 9).toISOString(), at)).toBe('Today')
    expect(dayLabelOf(new Date(2026, 10, 10, 23).toISOString(), at)).toBe('Yesterday')
    expect(dayLabelOf(new Date(2026, 10, 9, 9).toISOString(), at)).toBe('Monday')
    expect(dayLabelOf(new Date(2026, 9, 1, 9).toISOString(), at)).toMatch(/October 1/)
  })

  test('days are separated only when a question is older than today', async () => {
    const today = question(2, new Date(2026, 10, 11, 10).toISOString())
    const yesterday = question(1, new Date(2026, 10, 10, 18).toISOString())
    expect(spansDays([today], at)).toBe(false)
    expect(spansDays([today, yesterday], at)).toBe(true)
    expect(groupByDay([today, yesterday], at).map(g => g.label)).toEqual(['Yesterday', 'Today'])
  })

  test('an answer carries when its question was asked', async () => {
    const q = question(3, new Date(2026, 10, 11, 10, 42).toISOString())
    expect(answerTextOf(q, ' B: yes ')).toBe('[Q3 · asked 2026-11-11 10:42] B: yes')
    expect(answeredRef('[Q3 · asked 2026-11-11 10:42] B')).toBe(3)
    expect(answeredRef('  [Q12] ok')).toBe(12)
    expect(answeredRef('see Q3')).toBeUndefined()
  })
})

test('/questions opens the pane', async ($, on) => {
  const { commands } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(commands).toEqual(['questions'])

  const ran = await $.command.run({ command: 'questions' })
  expect(ran.text).toBe('No pending questions.')
})

test('a question is answered from the pane and leaves it', async ($, on) => {
  const { submitted, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const opened = await $.tool.call({
    tool: OPEN,
    question: 'Do I add dependency X?',
    context: 'It is needed to parse dates.',
    options: [{ label: 'Yes' }, { label: 'No' }],
    recommended: 'B',
  })
  expect(String(opened.result)).toMatch(/^Registered as Q1, asked /)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /add dependency/ }))?.text).toBe('Do I add dependency X?')

  await ui.press({ key: 'q-1' })
  expect((await ui.find({ type: 'Text', text: /It is needed/ }))?.text).toBe('It is needed to parse dates.')

  await ui.press({ key: 'option-B' })
  await ui.input({ key: 'answer-1', text: 'B: No, use Intl', kind: 'submit' })
  await clock.settle()

  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^\[Q1 · asked \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] B: No, use Intl$/)
  expect((await ui.find({ type: 'Text', text: /No pending questions/ }))?.text).toBe('No pending questions.')
  await ui.unmount()
})

test('the list opens a question from its title, not from its date', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: OPEN, question: 'Do I delete the old branch?' })

  const ui = await $.ui.mount(PANE)
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.key).toBe('q-1')
  expect(buttons[0]?.text).toBe('Do I delete the old branch?')
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

  await $.prompt.submit({ text: '[Q1 · asked 2026-11-11 10:42] ok', wait: false, origin: { kind: 'composer' } })

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
  expect(await ui.find({ type: 'Text', text: /queued/ })).toBeUndefined()
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
  await $.tool.call({ tool: OPEN, question: 'pick', options: [{ label: 'Yes' }, { label: 'No' }] })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'q-1' })
  expect(await ui.find({ type: 'Text', text: /^● / })).toBeUndefined()

  await ui.press({ key: 'option-A' })
  expect((await ui.find({ type: 'Text', text: /^● / }))?.text).toBe('● A: Yes')

  await ui.press({ key: 'option-B' })
  expect((await ui.find({ type: 'Text', text: /^● / }))?.text).toBe('● B: No')

  await ui.input({ key: 'answer-1', text: 'B: No, but later', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^● / })).toBeUndefined()
  await ui.unmount()
})

describe('scrollbar helpers', () => {
  test('there is no thumb while the content fits', async () => {
    expect(thumbOf({ offset: 0, bodyRows: 10, contentRows: 10 })).toBeUndefined()
    expect(thumbOf({ offset: 0, bodyRows: 10, contentRows: 4 })).toBeUndefined()
  })

  test('the thumb is as long as the share of the content that shows', async () => {
    expect(thumbOf({ offset: 0, bodyRows: 10, contentRows: 20 })).toEqual({ start: 0, size: 5 })
    expect(thumbOf({ offset: 0, bodyRows: 5, contentRows: 200 })).toEqual({ start: 0, size: 1 })
  })

  test('the thumb moves from the top to the bottom of the track', async () => {
    expect(thumbOf({ offset: 5, bodyRows: 10, contentRows: 20 })).toEqual({ start: 3, size: 5 })
    expect(thumbOf({ offset: 10, bodyRows: 10, contentRows: 20 })).toEqual({ start: 5, size: 5 })
    expect(thumbOf({ offset: 15, bodyRows: 5, contentRows: 20 })).toEqual({ start: 4, size: 1 })
    expect(thumbOf({ offset: 99, bodyRows: 5, contentRows: 20 })).toEqual({ start: 4, size: 1 })
  })

  test('text wraps at word boundaries and breaks words longer than a row', async () => {
    expect(rowsOf('', 10)).toBe(1)
    expect(rowsOf('short', 10)).toBe(1)
    expect(rowsOf('one two three', 7)).toBe(2)
    expect(rowsOf('one\ntwo', 10)).toBe(2)
    expect(rowsOf('abcdefghijkl', 5)).toBe(3)
  })

  test('the list height counts each question, its header and the gaps between them', async () => {
    const at = new Date(2026, 10, 11, 12, 0)
    const asked = new Date(2026, 10, 11, 11, 0).toISOString()
    expect(listRows([question(1, asked)], at, 60)).toBe(2)
    expect(listRows([question(1, asked), question(2, asked)], at, 60)).toBe(5)
    const yesterday = new Date(2026, 10, 10, 11, 0).toISOString()
    expect(listRows([question(1, yesterday), question(2, asked)], at, 60)).toBe(9)
  })

  test('the detail height grows with the context and the options', async () => {
    const at = new Date(2026, 10, 11, 12, 0)
    const q = question(1, new Date(2026, 10, 11, 11, 0).toISOString())
    const bare = detailRows(q, at, 60)
    expect(detailRows({ ...q, context: 'word '.repeat(60).trim() }, at, 60)).toBe(bare + 1 + 5)
    expect(detailRows({ ...q, options: [{ key: 'A', label: 'Yes' }, { key: 'B', label: 'No' }] }, at, 60)).toBe(bare + 1 + 2)
  })
})
