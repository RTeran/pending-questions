import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  ACK_SOUND,
  answeredRef,
  chime,
  answerTextOf,
  dayLabelOf,
  soundOf,
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

const ALERT = ['/usr/bin/osascript', '-e', 'beep']

type AlertOutcome = 'ok' | 'exit' | 'reject'

const engine = (
  on: On,
  stored: Record<string, unknown> = {},
  probe = 'main\n',
  playFails = false,
  alert: AlertOutcome = 'ok',
) => {
  const submitted: string[] = []
  const plays: unknown[] = []
  const alerts: (readonly string[])[] = []
  const logs: string[] = []
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('audio.play', async (_, e) => {
    plays.push(e.clip)
    await Promise.resolve()
    if (playFails) throw new Error('no audio device')
    return { value: undefined }
  })
  const tools: string[] = []
  const commands: string[] = []
  on('process.run', async (_, e) => {
    const isAlert = e.argv[0] === ALERT[0]
    if (isAlert) {
      alerts.push(e.argv)
      await Promise.resolve()
      if (alert === 'reject') throw new Error('osascript did not start')
    }
    const exitCode = isAlert && alert === 'exit' ? 1 : 0
    const stdout = isAlert ? '' : probe
    const stderr = exitCode === 0 ? '' : 'execution error'
    return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
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
  on('ui.scroll', () => ({}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { submitted, clock, tools, commands, plays, alerts, logs }
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
    expect(thumbOf({ offset: 0, bodyRows: 0, contentRows: 4 })).toBeUndefined()
    expect(thumbOf({ offset: 0, bodyRows: -1, contentRows: 4 })).toBeUndefined()
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
    expect(rowsOf('ab abcdefghijkl', 5)).toBe(3)
    expect(rowsOf('a bcdef g', 5)).toBe(3)
  })

  test('the list height counts each question, its header and the gaps between them', async () => {
    const at = new Date(2026, 10, 11, 12, 0)
    const asked = new Date(2026, 10, 11, 11, 0).toISOString()
    expect(listRows([question(1, asked)], at, 60)).toBe(2)
    expect(listRows([question(1, asked), question(2, asked)], at, 60)).toBe(5)
    const yesterday = new Date(2026, 10, 10, 11, 0).toISOString()
    expect(listRows([question(1, yesterday), question(2, asked)], at, 60)).toBe(9)
  })

  test('a queued answer replaces the answer field with one line', async () => {
    const at = new Date(2026, 10, 11, 12, 0)
    const q = question(1, new Date(2026, 10, 11, 11, 0).toISOString())
    expect(detailRows({ ...q, queuedAt: new Date(2026, 10, 11, 11, 30).toISOString() }, at, 60)).toBe(6)
  })

  test('the detail height grows with the context and the options', async () => {
    const at = new Date(2026, 10, 11, 12, 0)
    const q = question(1, new Date(2026, 10, 11, 11, 0).toISOString())
    const bare = detailRows(q, at, 60)
    expect(detailRows({ ...q, context: 'word '.repeat(60).trim() }, at, 60)).toBe(bare + 1 + 5)
    expect(detailRows({ ...q, options: [{ key: 'A', label: 'Yes' }, { key: 'B', label: 'No' }] }, at, 60)).toBe(bare + 1 + 2)
  })
})

const sized = (bodyRows: number, offset = 0) => ({ ...PANE, props: { ...PANE.props, scroll: { offset, bodyRows } } })

const scrolled = (offset: number, bodyRows: number, contentRows: number) =>
  ({
    component: 'Pane',
    requestId: 'pending-questions',
    offset,
    by: offset,
    bodyRows,
    contentRows,
    origin: { kind: 'person' },
  }) as never

const thumbRows = async (ui: { find: (q: { type: string; key: string }) => Promise<{ children: unknown[] } | undefined> }) =>
  ((await ui.find({ type: 'Box', key: 'scrollbar' }))?.children ?? []).flatMap((row, i) => (JSON.stringify(row).includes('█') ? [i] : []))

describe('scrollbar', () => {
  test('a list taller than the pane shows a scrollbar with the thumb at the top', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    for (const n of [1, 2, 3, 4, 5, 6]) await $.tool.call({ tool: OPEN, question: `question ${n}` })

    const ui = await $.ui.mount(sized(5))
    const bar = await ui.find({ type: 'Box', key: 'scrollbar' })
    expect(bar?.props).toMatchObject({ position: 'absolute', right: 0, top: 0, height: 5 })
    expect(await ui.findAll({ type: 'Text', text: /^[│█]$/ })).toHaveLength(5)
    expect(await thumbRows(ui)).toEqual([0])

    await ui.redraw(sized(5, 12).props)
    expect((await ui.find({ type: 'Box', key: 'scrollbar' }))?.props).toMatchObject({ top: 12 })
    expect(await thumbRows(ui)).toEqual([4])
    await ui.unmount()
  })

  test('a list that fits shows no scrollbar', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: OPEN, question: 'two' })

    const ui = await $.ui.mount(sized(40))
    expect(await ui.find({ type: 'Box', key: 'scrollbar' })).toBeUndefined()
    await ui.unmount()
  })

  test('a question with a long context shows a scrollbar', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'long', context: 'word '.repeat(200).trim() })

    const ui = await $.ui.mount(sized(10))
    expect(await ui.find({ type: 'Box', key: 'scrollbar' })).toBeUndefined()
    await ui.press({ key: 'q-1' })
    expect(await ui.find({ type: 'Box', key: 'scrollbar' })).toBeDefined()
    await ui.unmount()
  })

  test('the thumb follows the content height the engine reports on a scroll', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    for (const n of [1, 2, 3, 4, 5, 6]) await $.tool.call({ tool: OPEN, question: `question ${n}` })

    const ui = await $.ui.mount(sized(5))
    await $.ui.scroll(scrolled(12, 5, 40))
    await ui.redraw(sized(5, 12).props)
    expect(await thumbRows(ui)).toEqual([1])
    await ui.unmount()
  })

  test('a content height reported for other content is not reused', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    for (const n of [1, 2, 3, 4, 5, 6]) await $.tool.call({ tool: OPEN, question: `question ${n}` })

    const ui = await $.ui.mount(sized(5))
    await $.ui.scroll(scrolled(12, 5, 40))
    for (const n of [2, 3, 4, 5, 6]) await $.tool.call({ tool: CLOSE, n })
    await ui.redraw(sized(5, 0).props)
    expect(await ui.find({ type: 'Box', key: 'scrollbar' })).toBeUndefined()
    await ui.unmount()
  })

  test('the empty state has no scrollbar', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount(sized(1))
    expect(await ui.find({ type: 'Box', key: 'scrollbar' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('sound', () => {
  test('the sound is a short WAV built in code', async () => {
    expect(ACK_SOUND.mime).toBe('audio/wav')
    const bytes = atob(ACK_SOUND.base64)
    expect(bytes.slice(0, 4)).toBe('RIFF')
    expect(bytes.slice(8, 12)).toBe('WAVE')
    expect(bytes.length).toBeLessThan(40_000)
  })

  test('the WAV header matches the samples it carries', async () => {
    const raw = Uint8Array.from(atob(ACK_SOUND.base64), c => c.charCodeAt(0))
    const data = new DataView(raw.buffer)
    expect(data.getUint32(4, true)).toBe(raw.length - 8)
    expect(data.getUint32(40, true)).toBe(raw.length - 44)
    expect(data.getUint16(20, true)).toBe(1)
    expect(data.getUint16(22, true)).toBe(1)
    expect(data.getUint32(24, true)).toBe(22_050)
    expect(data.getUint16(34, true)).toBe(16)
    const samples = Array.from({ length: (raw.length - 44) / 2 }, (_, i) => data.getInt16(44 + i * 2, true))
    expect(samples.some(v => v !== 0)).toBe(true)
  })

  test('the sound option falls back to the alert', async () => {
    expect(soundOf('ding')).toBe('ding')
    expect(soundOf('off')).toBe('off')
    expect(soundOf('alert')).toBe('alert')
    expect(soundOf(undefined)).toBe('alert')
    expect(soundOf('trumpet')).toBe('alert')
    expect(soundOf(true)).toBe('alert')
  })

  test('by default a new question plays the macOS alert once', async ($, on) => {
    const { plays, alerts } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    expect(alerts).toEqual([ALERT])
    expect(plays).toEqual([])
  })

  test('the ding option plays the built-in WAV and no alert', { options: { sound: 'ding' } }, async ($, on) => {
    const { plays, alerts } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    expect(plays).toEqual([ACK_SOUND])
    expect(alerts).toEqual([])
  })

  test('the off option plays nothing', { options: { sound: 'off' } }, async ($, on) => {
    const { plays, alerts } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    expect(plays).toEqual([])
    expect(alerts).toEqual([])
  })

  test('restoring stored questions plays no sound', async ($, on) => {
    const { plays, alerts } = engine(on, { 'open:session-1': [question(1, new Date().toISOString())], 'seq:session-1': 1 })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeDefined()
    expect([...plays, ...alerts]).toEqual([])
    await ui.unmount()
  })

  test('closing or answering a question plays no sound', async ($, on) => {
    const { alerts, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: OPEN, question: 'two' })
    await clock.advance(5_000)
    const before = alerts.length
    await $.tool.call({ tool: CLOSE, n: 1 })
    await $.prompt.submit({ text: '[Q2 · asked 2026-11-11 10:42] ok', wait: false, origin: { kind: 'composer' } })
    expect(alerts).toHaveLength(before)
  })

  test('a question from a subagent plays no sound', async ($, on) => {
    const { plays, alerts } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'mine', agentId: 'impl-1' })
    expect([...plays, ...alerts]).toEqual([])
  })

  test('an empty question plays no sound', async ($, on) => {
    const { plays, alerts } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: '   ' })
    expect([...plays, ...alerts]).toEqual([])
  })

  test('alerts less than a second apart play once', async ($, on) => {
    const { alerts, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await clock.advance(500)
    await $.tool.call({ tool: OPEN, question: 'two' })
    expect(alerts).toHaveLength(1)
  })

  test('an alert more than a second after the last one plays again', async ($, on) => {
    const { alerts, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await clock.advance(1_001)
    await $.tool.call({ tool: OPEN, question: 'two' })
    expect(alerts).toHaveLength(2)
  })

  test('dings less than a second apart play once', { options: { sound: 'ding' } }, async ($, on) => {
    const { plays, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await clock.advance(500)
    await $.tool.call({ tool: OPEN, question: 'two' })
    expect(plays).toHaveLength(1)
  })

  test('a player that throws at once is logged and does not throw', async () => {
    const logged: string[] = []
    const $ = {
      clock: { now: async () => 1e15 },
      audio: {
        play: () => {
          throw new Error('no audio noun')
        },
      },
      ui: { log: (text: string) => void logged.push(text) },
    }
    await chime($ as never, 'ding')
    await Promise.resolve()
    await Promise.resolve()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/no audio noun/)
  })

  test('an alert that throws at once is logged and does not throw', async () => {
    const logged: string[] = []
    const $ = {
      clock: { now: async () => 2e15 },
      process: {
        run: () => {
          throw new Error('no process noun')
        },
      },
      ui: { log: (text: string) => void logged.push(text) },
    }
    await chime($ as never, 'alert')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/no process noun/)
  })

  test('a ding that cannot play still registers the question', { options: { sound: 'ding' } }, async ($, on) => {
    const { plays, logs, clock } = engine(on, {}, 'main\n', true)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const opened = await $.tool.call({ tool: OPEN, question: 'one' })
    expect(String(opened.result)).toMatch(/^Registered as Q1,/)
    expect(plays).toHaveLength(1)
    await clock.settle()
    expect(logs.some(line => /sound did not play/.test(line))).toBe(true)
  })

  test('an alert that cannot start still registers the question', async ($, on) => {
    const { alerts, logs, clock } = engine(on, {}, 'main\n', false, 'reject')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const opened = await $.tool.call({ tool: OPEN, question: 'one' })
    expect(String(opened.result)).toMatch(/^Registered as Q1,/)
    expect(alerts).toHaveLength(1)
    await clock.settle()
    expect(logs.some(line => /sound did not play/.test(line))).toBe(true)
  })

  test('an alert that exits with an error is logged', async ($, on) => {
    const { alerts, logs, clock } = engine(on, {}, 'main\n', false, 'exit')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const opened = await $.tool.call({ tool: OPEN, question: 'one' })
    expect(String(opened.result)).toMatch(/^Registered as Q1,/)
    expect(alerts).toHaveLength(1)
    await clock.settle()
    expect(logs.some(line => /exit code 1.*execution error/.test(line))).toBe(true)
  })
})

describe('scrollbar cache', () => {
  test('a redraw at another width estimates again', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    for (const n of [1, 2, 3, 4, 5, 6]) await $.tool.call({ tool: OPEN, question: `question ${n}` })

    const ui = await $.ui.mount(sized(5))
    await $.ui.scroll(scrolled(12, 5, 40))
    await ui.redraw({ ...sized(5, 12).props, bodyColumns: 50 })
    expect(await thumbRows(ui)).toEqual([4])
    await ui.unmount()
  })

  test('opening a question ignores the height cached for the list', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    for (const n of [1, 2, 3, 4, 5, 6]) await $.tool.call({ tool: OPEN, question: `question ${n}` })

    const ui = await $.ui.mount(sized(5))
    await $.ui.scroll(scrolled(12, 5, 40))
    await ui.redraw(sized(5, 0).props)
    await ui.press({ key: 'q-1' })
    expect(await thumbRows(ui)).toEqual([0, 1, 2])
    await ui.unmount()
  })
})
