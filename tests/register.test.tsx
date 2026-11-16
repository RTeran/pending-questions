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
  hashOf,
  isUnknownSound,
  normalize,
  summarizeChange,
  listRows,
  rowsOf,
  spansDays,
  thumbOf,
} from '../hooks/register'
import type { Question } from '../types'

const OPEN = 'mcp__pending-questions__question_open'
const CLOSE = 'mcp__pending-questions__question_close'
const ACTION_OPEN = 'mcp__pending-questions__action_open'
const ACTION_CLOSE = 'mcp__pending-questions__action_close'

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

const navTexts = async (ui: { findAll: (q: { type: string }) => Promise<readonly { key?: string; text?: string }[]> }) =>
  Object.fromEntries((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('nav-')).map(b => [b.key, b.text]))

const ALERT = ['/usr/bin/osascript', '-e', 'beep']

const TASKS = '# Tasks\n- [ ] one\n- [ ] two\n'

type AlertOutcome = 'ok' | 'exit' | 'reject'

const engine = (
  on: On,
  stored: Record<string, unknown> = {},
  probe = 'main\n',
  playFails = false,
  alert: AlertOutcome = 'ok',
  initialFiles: Record<string, string> = { '/repo/TASKS.md': TASKS },
) => {
  const submitted: string[] = []
  const files = new Map<string, { text: string; mtimeMs: number; size?: number }>(
    Object.entries(initialFiles).map(([path, text]) => [path, { text, mtimeMs: 1 }]),
  )
  let writes = 1
  let isReadFailing = false
  let isStatFailing = false
  const reads: string[] = []
  const fs = {
    write: (path: string, text: string, size?: number) => void files.set(path, { text, mtimeMs: ++writes, size }),
    remove: (path: string) => void files.delete(path),
    reads,
    failReads: (isFailing = true) => {
      isReadFailing = isFailing
    },
    failStats: (isFailing = true) => {
      isStatFailing = isFailing
    },
    failRoot: () => {
      isRootFailing = true
    },
  }
  let isRootFailing = false
  on('session.root', () => {
    if (isRootFailing) throw new Error('no root')
    return { value: '/repo' }
  })
  mock.env(on, { HOME: '/home/me' })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.stat', (_, e) => {
    const file = files.get(e.path)
    if (!file) throw new Error(`ENOENT: ${e.path}`)
    if (isStatFailing) throw new Error(`EACCES: ${e.path}`)
    return { value: { kind: 'file', size: file.size ?? file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const file = files.get(e.path)
    if (!file) throw new Error(`ENOENT: ${e.path}`)
    if (isReadFailing) throw new Error(`EIO: ${e.path}`)
    return { value: file.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  on('tool.call', () => ({ result: 'written' }))
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
  const store = new Map(Object.entries(stored))
  const storeReads: string[] = []
  on('store.get', (_, e) => {
    storeReads.push(e.key)
    return { value: store.get(e.key) }
  })
  let isStoreFailing = false
  let isStoreFailingAfterSubmit = false
  on('store.set', (_, e) => {
    if (isStoreFailing) throw new Error('disk full')
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  let sessionId = 'session-1'
  on('session.id', () => ({ value: sessionId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => {
    tools.push(e.name)
    return { value: { tool: e.name } }
  })
  const opened: string[] = []
  const titles: string[] = []
  let isOpenFailing = false
  on('ui.open', (_, e) => {
    if (isOpenFailing) throw new Error('no room for the pane')
    opened.push(e.id)
    titles.push(e.title ?? '')
    return { value: { isPlaced: true } }
  })
  let isPaneShown = true
  let isPanesFailing = false
  on('ui.panes', () => {
    if (isPanesFailing) throw new Error('no panes')
    return {
      value: isPaneShown ? [{ id: 'pending-questions', title: 'Agent inbox', isShown: true, isFocused: false, isPlaced: true }] : [],
    }
  })
  on('ui.scroll', () => ({}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  const pluginSubmits: string[] = []
  let isSubmitFailing = false
  let held: Promise<void> | undefined
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    if (e.origin.kind === 'plugin') pluginSubmits.push(e.text)
    if (isStoreFailingAfterSubmit) isStoreFailing = true
    if (held) await held
    if (isSubmitFailing) throw new Error('the lead is gone')
    return { text: e.text }
  })
  const control = {
    failSubmits: () => {
      isSubmitFailing = true
    },
    failStoreWritesAfterSubmit: () => {
      isStoreFailingAfterSubmit = true
    },
    failPanes: () => {
      isPanesFailing = true
    },
    failOpen: () => {
      isOpenFailing = true
    },
    hidePane: () => {
      isPaneShown = false
    },
    clear: (nextId: string) => {
      sessionId = nextId
    },
    holdSubmits: () => {
      let release = () => {}
      held = new Promise(resolve => {
        release = () => {
          held = undefined
          resolve()
        }
      })
      return release
    },
  }
  return { statuses, titles, storeReads, submitted, pluginSubmits, clock, tools, commands, plays, alerts, logs, opened, toasts, fs, store, control }
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

  const ran = await $.command.run({
    command: 'questions',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(ran.text).toBe('No pending questions or actions.')
})

test('/questions counts the pending actions too', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
  const ran = await $.command.run({
    command: 'questions',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(ran.text).toBe('Pane opened: 0 questions and 1 action pending.')
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
  expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeUndefined()
  expect(await navTexts(ui)).toEqual({ 'nav-tasks': '▸ 📋 Tasks 0/2' })
  await ui.unmount()
})

test('the list opens a question from its title, not from its date', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: OPEN, question: 'Do I delete the old branch?' })

  const ui = await $.ui.mount(PANE)
  const buttons = (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('q-'))
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

test('a reply in a teammate process reads no store key', async ($, on) => {
  const { storeReads } = engine(on, {}, 'teammate\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '[Q1 · asked 2026-11-11 10:42] ok', wait: false, origin: { kind: 'composer' } })
  expect(storeReads).toEqual([])
})

test('the main session and the lead get the question and action tools', async ($, on) => {
  const { tools } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(tools).toEqual(['question_open', 'question_close', 'action_open', 'action_close'])
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

    await ui.redraw(sized(5, 14).props)
    expect((await ui.find({ type: 'Box', key: 'scrollbar' }))?.props).toMatchObject({ top: 14 })
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
    engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    const ui = await $.ui.mount(sized(1))
    await ui.press({ key: 'nav-tasks' })
    await ui.press({ key: 'tasks-dismiss' })
    expect(await ui.find({ type: 'Text', text: /^Nothing pending/ })).toBeDefined()
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
    expect(soundOf(false)).toBe('off')
  })

  test('only a value that is not a known sound is reported as unknown', async () => {
    expect(isUnknownSound('trumpet')).toBe(true)
    expect(isUnknownSound(true)).toBe(true)
    expect(isUnknownSound(undefined)).toBe(false)
    expect(isUnknownSound(false)).toBe(false)
    expect(isUnknownSound('ding')).toBe(false)
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
    await (await chime($ as never, 'ding')).played
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
    await (await chime($ as never, 'alert')).played
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/no process noun/)
  })

  test('a failing sound with a failing log still settles', async () => {
    const $ = {
      clock: { now: async () => 3e15 },
      audio: {
        play: () => {
          throw new Error('no audio noun')
        },
      },
      ui: {
        log: () => {
          throw new Error('no log noun')
        },
      },
    }
    const { played } = await chime($ as never, 'ding')
    await expect(played).resolves.toBeUndefined()
  })

  test('a clock that fails with a failing log still settles', async () => {
    const $ = {
      clock: {
        now: async () => {
          throw new Error('no clock')
        },
      },
      ui: {
        log: () => {
          throw new Error('no log noun')
        },
      },
    }
    await expect(chime($ as never, 'alert')).resolves.toEqual({ played: undefined })
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
    await ui.redraw({ ...sized(5, 14).props, bodyColumns: 50 })
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
    expect(await thumbRows(ui)).toEqual([0, 1])
    await ui.unmount()
  })
})

describe('actions', () => {
  test('actions and their numbering are kept in the store for the session', async ($, on) => {
    const { store } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'one' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'two', url: 'https://example.com' })
    await $.tool.call({ tool: ACTION_CLOSE, n: 1 })
    expect(store.get('aseq:session-1')).toBe(2)
    expect(store.get('actions:session-1')).toMatchObject([{ n: 2, action: 'two', url: 'https://example.com' }])
  })

  test('a Done that cannot be sent stays pending and can be pressed again', async ($, on) => {
    const { control, toasts, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    control.failSubmits()

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-actions' })
    await ui.press({ key: 'a-1' })
    await ui.press({ key: 'action-done' })
    await clock.settle()
    expect(toasts).toContain('Could not mark A1 as done. It is still pending.')
    await ui.press({ key: 'a-1' })
    expect(await ui.find({ type: 'Button', key: 'action-done' })).toBeDefined()
    await ui.unmount()
  })

  test('a Done that was sent is never offered again, even if a later step fails', async ($, on) => {
    const { control, toasts, logs, pluginSubmits, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-actions' })
    await ui.press({ key: 'a-1' })
    control.failStoreWritesAfterSubmit()
    await ui.press({ key: 'action-done' })
    await clock.settle()
    expect(pluginSubmits).toEqual(['[A1 · done]'])
    expect(toasts.filter(text => /Could not/.test(text))).toEqual([])
    expect(logs.some(line => /A1/.test(line))).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'action-done' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'a-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /queued|Marked done/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a done typed in the chat while Done is on its way closes the action once', async ($, on) => {
    const { control, toasts, pluginSubmits, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    const release = control.holdSubmits()

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-actions' })
    await ui.press({ key: 'a-1' })
    await ui.press({ key: 'action-done' })
    await ui.press({ key: 'a-1' })
    expect(await ui.find({ type: 'Button', key: 'action-done' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Marked done at/ })).toBeDefined()

    release()
    await $.prompt.submit({ text: '[A1 · done] merged', wait: false, origin: { kind: 'composer' } })
    await clock.settle()
    expect(pluginSubmits).toEqual(['[A1 · done]'])
    expect(toasts.filter(text => text === 'A1 done.')).toHaveLength(1)
    await ui.unmount()
  })

  test('only a message that starts with the action reference closes it', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    await $.prompt.submit({ text: 'about [A1 · done]', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '[A12 · done]', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({
      text: '/note [A1 · done]',
      wait: false,
      origin: { kind: 'composer' },
      command: { name: 'note', args: '[A1 · done]' },
    } as never)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-actions' })
    expect(await ui.find({ type: 'Button', key: 'a-1' })).toBeDefined()
    await ui.unmount()
  })

  test('a subagent may close an action, as it may close a question', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    const closed = await $.tool.call({ tool: ACTION_CLOSE, n: 1, agentId: 'impl-1' })
    expect(String(closed.result)).toBe('A1 removed from the pane.')
  })

  test('closing an action needs its number', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    const denied = await $.tool.call({ tool: ACTION_CLOSE, n: 'A1' })
    expect(denied.deny).toBe('n must be the number of the action, the n of A<n>.')
  })

  test('a sound that fails does not fail the new action or question', async ($, on) => {
    const { opened } = engine(on, {}, 'main\n', false, 'reject')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const action = await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(String(action.result)).toMatch(/^Registered as A1,/)
    const question = await $.tool.call({ tool: OPEN, question: 'one' })
    expect(String(question.result)).toMatch(/^Registered as Q1,/)
    expect(opened).toHaveLength(2)
  })

  test('a stored actions list in an unknown shape is logged and ignored', async ($, on) => {
    const { logs } = engine(on, { 'actions:session-1': [{ title: 'old' }] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(logs.some(line => /stored actions/.test(line))).toBe(true)
  })

  test('an action is registered with its own numbering', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    const opened = await $.tool.call({ tool: ACTION_OPEN, action: 'Merge PR #8', url: 'https://github.com/x/y/pull/8' })
    expect(String(opened.result)).toMatch(/^Registered as A1, asked /)
  })

  test('an action is reachable from the pane and done from its detail', async ($, on) => {
    const { submitted, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'Merge PR #8', context: 'CI is green.', url: 'https://github.com/x/y/pull/8' })

    const ui = await $.ui.mount(PANE)
    expect((await navTexts(ui))['nav-actions']).toBe('▸ 🛠 Actions (1)')
    expect((await ui.find({ type: 'Button', key: 'a-1' }))?.text).toBe('Merge PR #8')

    await ui.press({ key: 'a-1' })
    expect((await ui.find({ type: 'Text', text: /CI is green/ }))?.text).toBe('CI is green.')
    expect(await ui.find({ type: 'Text', text: /pull\/8/ })).toBeDefined()

    await ui.press({ key: 'action-done' })
    await clock.settle()
    expect(submitted).toEqual(['[A1 · done]'])
    expect(await navTexts(ui)).toEqual({ 'nav-tasks': '▸ 📋 Tasks 0/2' })
    await ui.unmount()
  })

  test('a done typed in the chat closes the action and leaves the question with the same number', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    await $.tool.call({ tool: ACTION_OPEN, action: 'test it' })

    await $.prompt.submit({ text: '[A1 · done]', wait: false, origin: { kind: 'composer' } })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-questions' })
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeDefined()
    await ui.press({ key: 'nav-actions' })
    expect(await ui.find({ type: 'Button', key: 'a-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'a-2' })).toBeDefined()
    await ui.unmount()
  })

  test('an answer to a question leaves the action with the same number', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    await $.prompt.submit({ text: '[Q1 · asked 2026-11-11 10:42] ok', wait: false, origin: { kind: 'composer' } })

    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeUndefined()
    await ui.press({ key: 'nav-actions' })
    expect(await ui.find({ type: 'Button', key: 'a-1' })).toBeDefined()
    await ui.unmount()
  })

  test('a message from a peer does not close an action', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    await $.prompt.submit({ text: '[A1 · done]', wait: false, origin: { kind: 'peer' } as never })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-actions' })
    expect(await ui.find({ type: 'Button', key: 'a-1' })).toBeDefined()
    await ui.unmount()
  })

  test('action numbers are never reused after an action is closed', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'one' })
    const closed = await $.tool.call({ tool: ACTION_CLOSE, n: 1 })
    expect(String(closed.result)).toBe('A1 removed from the pane.')
    const missing = await $.tool.call({ tool: ACTION_CLOSE, n: 1 })
    expect(missing.deny).toBe('There is no pending A1.')

    const next = await $.tool.call({ tool: ACTION_OPEN, action: 'two' })
    expect(String(next.result)).toMatch(/^Registered as A2,/)
  })

  test('an empty action is denied', async ($, on) => {
    const { alerts } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const denied = await $.tool.call({ tool: ACTION_OPEN, action: '  ' })
    expect(denied.deny).toBe('action is required.')
    expect(alerts).toEqual([])
  })

  test('a subagent cannot register an action', async ($, on) => {
    const { alerts } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const denied = await $.tool.call({ tool: ACTION_OPEN, action: 'mine', agentId: 'impl-1' })
    expect(denied.deny).toMatch(/never call this/)
    expect(alerts).toEqual([])
  })

  test('a new action plays the alert and opens the pane', async ($, on) => {
    const { alerts, opened } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(alerts).toEqual([ALERT])
    expect(opened).toEqual(['pending-questions'])
  })

  test('a question and an action less than a second apart each play', async ($, on) => {
    const { alerts, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await clock.advance(500)
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(alerts).toHaveLength(2)
  })

  test('stored actions are restored without a sound and without their queued mark', async ($, on) => {
    const asked = new Date(2026, 10, 10, 18).toISOString()
    const { alerts, plays } = engine(on, {
      'actions:session-1': [{ n: 3, action: 'merge it', context: '', askedAt: asked, queuedAt: asked }],
      'aseq:session-1': 3,
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-actions' })
    expect(await ui.find({ type: 'Text', text: /queued/ })).toBeUndefined()
    await ui.press({ key: 'a-3' })
    expect(await ui.find({ type: 'Button', key: 'action-done' })).toBeDefined()
    expect([...alerts, ...plays]).toEqual([])
    await ui.unmount()

    const next = await $.tool.call({ tool: ACTION_OPEN, action: 'another' })
    expect(String(next.result)).toMatch(/^Registered as A4,/)
  })

  test('closing the open last action moves the pane to the next section', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-actions' })
    await ui.press({ key: 'a-1' })
    await $.tool.call({ tool: ACTION_CLOSE, n: 1 })
    expect(await ui.find({ type: 'Button', key: 'action-done' })).toBeUndefined()
    expect(await navTexts(ui)).toEqual({ 'nav-tasks': '▸ 📋 Tasks 0/2' })
    await ui.unmount()
  })
})

test('a view stored by the previous version is read as the list', async ($, on) => {
  engine(on, { 'open:session-1': [question(1, new Date().toISOString())], 'seq:session-1': 1 })
  on('state.get', (_, e, next) =>
    e.key === 'view' ? { value: { value: { shape: 'view-1', value: { kind: 'question', n: 1 } }, version: 1 } } : next(e),
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeUndefined()
  await ui.unmount()
})

describe('tasks helpers', () => {
  test('normalizing drops trailing spaces, blank runs and line-ending noise', async () => {
    expect(normalize('# T  \r\n\n\n\n- [ ] a \n\n')).toBe('# T\n\n- [ ] a\n')
    expect(normalize('\n\n- [ ] a')).toBe('- [ ] a\n')
    expect(normalize('')).toBe('')
  })

  test('texts that normalize alike share a hash', async () => {
    expect(hashOf(normalize('- [ ] a  \n\n\n'))).toBe(hashOf(normalize('- [ ] a')))
    expect(hashOf('- [ ] a\n')).not.toBe(hashOf('- [x] a\n'))
    expect(hashOf('')).toMatch(/^[0-9a-f]{8}$/)
  })

  test('checking boxes counts as tasks done', async () => {
    const change = summarizeChange('- [ ] a\n- [ ] b\n- [ ] c\n', '- [x] a\n* [X] b\n- [ ] c\n')
    expect(change).toMatchObject({ done: 2, reopened: 0, added: 0, sections: 0, isNotable: true })
    expect(change.text).toBe('2 tasks done')
  })

  test('new items, reopened items and new headings are counted', async () => {
    const change = summarizeChange('# A\n- [x] a\n', '# A\n- [ ] a\n## B\n- [ ] b\n- [x] c\n')
    expect(change).toMatchObject({ done: 0, reopened: 1, added: 2, sections: 1, isNotable: true })
    expect(change.text).toBe('1 task reopened, 2 added, 1 new section')
  })

  test('a done and an added task read like the brief', async () => {
    expect(summarizeChange('- [ ] a\n- [ ] b\n', '- [x] a\n- [x] b\n- [ ] c\n').text).toBe('2 tasks done, 1 added')
  })

  test('prose edits and removed items are not notable', async () => {
    expect(summarizeChange('Intro\n- [ ] a\n- [ ] b\n', 'Intro, longer\n- [ ] a\n').isNotable).toBe(false)
    expect(summarizeChange('# A\n', '# A\nsome notes\n').isNotable).toBe(false)
    expect(summarizeChange('- [ ] a\n', '- [ ] a\n').text).toBe('')
  })
})

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const taskSection = async ($: { prompt: { compose: (args: object) => Promise<{ sections: readonly { id: string; text: string }[] }> } }, args: object = {}) =>
  (
    await $.prompt.compose({
      model: 'claude-test',
      promptModel: 'claude-test',
      surfaces: ['terminal'],
      tools: [],
      outputStyle: null,
      traits: [],
      ...args,
    })
  ).sections.find(section => section.id === 'pending-questions:tasks')?.text

describe('tasks source', () => {
  test('a path stored for the project wins over the option and the default', { options: { tasksFile: 'plan/todo.md' } }, async ($, on) => {
    engine(on, { 'tasksFile:/repo': '/repo/notes/tasks.md' }, 'main\n', false, 'ok', { '/repo/notes/tasks.md': TASKS })
    await $.session.start(START)
    expect(await taskSection($ as never)).toBe('If you are the main session, not a subagent or a teammate, keep your task list in /repo/notes/tasks.md, using `- [ ]` / `- [x]` checkboxes.')
  })

  test('the option is used when the project has no stored path', { options: { tasksFile: 'plan/todo.md' } }, async ($, on) => {
    engine(on, {}, 'main\n', false, 'ok', { '/repo/plan/todo.md': TASKS })
    await $.session.start(START)
    expect(await taskSection($ as never)).toMatch(/in \/repo\/plan\/todo\.md,/)
  })

  test('TASKS.md under the project root is the default', async ($, on) => {
    engine(on)
    await $.session.start(START)
    expect(await taskSection($ as never)).toMatch(/in \/repo\/TASKS\.md,/)
  })

  test('a teammate prompt gets no task instruction', async ($, on) => {
    engine(on)
    await $.session.start(START)
    expect(await taskSection($ as never, { traits: ['teammate'] })).toBeUndefined()
  })

  test('a teammate process gets no task instruction and no polling', async ($, on) => {
    const { alerts } = engine(on, {}, 'teammate\n', false, 'ok', {})
    await $.session.start(START)
    expect(await taskSection($ as never)).toBeUndefined()
    expect(alerts).toEqual([])
  })

  test('the tasks file is shown in the pane', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })
    expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: TASKS })
    expect((await navTexts(ui))['nav-tasks']).toBe('▸ 📋 Tasks 0/2')
    await ui.unmount()
  })
})

describe('tasks setup', () => {
  test('a missing file opens the setup card with one chime', async ($, on) => {
    const { alerts, opened } = engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start(START)
    await $.session.start(START)
    expect(alerts).toEqual([ALERT])
    expect(opened).toEqual(['pending-questions'])

    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ type: 'Input', key: 'tasks-path' }))?.props).toMatchObject({ value: '/repo/TASKS.md' })
    await ui.unmount()
  })

  test('a session nobody can answer gets no setup card', async ($, on) => {
    const { alerts, opened } = engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start({ ...START, isInteractive: false })
    expect(alerts).toEqual([])
    expect(opened).toEqual([])
  })

  test('using a path stores it for the project and shows that file', async ($, on) => {
    const { fs } = engine(on, {}, 'main\n', false, 'ok', {})
    fs.write('/repo/docs/todo.md', TASKS)
    await $.session.start(START)

    const ui = await $.ui.mount(PANE)
    await ui.input({ key: 'tasks-path', text: 'docs/todo.md', kind: 'change' })
    await ui.press({ key: 'tasks-use' })
    expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: TASKS })
    await ui.unmount()

    await $.session.start(START)
    expect(await taskSection($ as never)).toMatch(/in \/repo\/docs\/todo\.md,/)
  })

  test('dismissing hides the card and the file is shown once it appears', async ($, on) => {
    const { fs, clock, alerts } = engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start(START)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tasks-dismiss' })
    expect(await ui.find({ type: 'Input', key: 'tasks-path' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'nav-tasks' })).toBeUndefined()

    fs.write('/repo/TASKS.md', 'Plan notes\n')
    await clock.advance(5_000)
    await ui.press({ key: 'nav-tasks' })
    expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: 'Plan notes\n' })
    expect(alerts).toHaveLength(1)
    await ui.unmount()
  })
})

describe('tasks notifications', () => {
  test('a task checked off notifies after two stable polls', async ($, on) => {
    const { fs, clock, alerts, toasts } = engine(on)
    await $.session.start(START)
    expect(alerts).toEqual([])

    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [x] two\n- [ ] three\n')
    await clock.advance(5_000)
    expect(alerts).toEqual([])
    await clock.advance(5_000)
    expect(alerts).toEqual([ALERT])
    expect(toasts).toContain('2 tasks done, 1 added')

    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toMatch(/three/)
    await ui.unmount()
  })

  test('an edit in the middle of a burst waits for the file to settle', async ($, on) => {
    const { fs, clock, alerts, toasts } = engine(on)
    await $.session.start(START)

    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(5_000)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [x] two\n')
    await clock.advance(5_000)
    expect(alerts).toEqual([])
    await clock.advance(5_000)
    expect(alerts).toEqual([ALERT])
    expect(toasts).toContain('2 tasks done')
  })

  test('an unrelated edit refreshes the pane without a sound', async ($, on) => {
    const { fs, clock, alerts, opened } = engine(on)
    await $.session.start(START)
    fs.write('/repo/TASKS.md', 'Some notes first.\n# Tasks\n- [ ] one\n')
    await clock.advance(15_000)
    expect(alerts).toEqual([])
    expect(opened).toEqual([])

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toMatch(/Some notes first/)
    await ui.unmount()
  })

  test('a silent edit moves the baseline, so a later check counts only itself', async ($, on) => {
    const { fs, clock, toasts } = engine(on)
    await $.session.start(START)
    fs.write('/repo/TASKS.md', '# Tasks\n- [ ] one\n')
    await clock.advance(15_000)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n')
    await clock.advance(15_000)
    expect(toasts.filter(text => /task/.test(text))).toEqual(['1 task done'])
  })

  test('a restart on an unchanged file is silent', async ($, on) => {
    const seen = { path: '/repo/TASKS.md', hash: hashOf(normalize(TASKS)), text: normalize(TASKS) }
    const { clock, alerts } = engine(on, { 'tasksSeen:/repo': seen })
    await $.session.start(START)
    await clock.advance(15_000)
    expect(alerts).toEqual([])
  })

  test('a restart after the file changed notifies what changed', async ($, on) => {
    const before = '# Tasks\n- [ ] one\n'
    const { clock, alerts, toasts } = engine(on, { 'tasksSeen:/repo': { path: '/repo/TASKS.md', hash: hashOf(before), text: before } })
    await $.session.start(START)
    await clock.advance(5_000)
    expect(alerts).toEqual([ALERT])
    expect(toasts).toContain('1 task added')
  })

  test('a restart whose stored baseline is of another file is silent', async ($, on) => {
    const before = '# Tasks\n- [ ] one\n'
    const { clock, toasts, opened } = engine(on, { 'tasksSeen:/repo': { path: '/repo/old.md', hash: hashOf(before), text: before } })
    await $.session.start(START)
    await clock.advance(15_000)
    expect(toasts.filter(text => /task|section/.test(text))).toEqual([])
    expect(opened).toEqual([])
  })

  test('switching to a file that already has tasks is silent', async ($, on) => {
    const { fs, clock, toasts, opened } = engine(on, {}, 'main\n', false, 'ok', {})
    fs.write('/repo/docs/todo.md', TASKS)
    await $.session.start(START)
    const ui = await $.ui.mount(PANE)
    await ui.input({ key: 'tasks-path', text: 'docs/todo.md', kind: 'change' })
    await ui.press({ key: 'tasks-use' })
    await clock.advance(15_000)
    expect(toasts.filter(text => /added|section/.test(text))).toEqual([])
    expect(opened).toHaveLength(1)
    await ui.unmount()
  })

  test('the tasks sound has its own gap and does not hold back a question', async ($, on) => {
    const { fs, clock, alerts } = engine(on)
    await $.session.start(START)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(10_000)
    expect(alerts).toHaveLength(1)
    await clock.advance(500)
    await $.tool.call({ tool: OPEN, question: 'one' })
    expect(alerts).toHaveLength(2)

    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [x] two\n')
    await clock.advance(10_000)
    expect(alerts).toHaveLength(2)
  })

  test('a Write to the tasks file refreshes the pane at once', async ($, on) => {
    const { fs } = engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })

    fs.write('/repo/TASKS.md', '# Tasks\n- [ ] written now\n')
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/TASKS.md', content: '' } as never)
    expect(result.result).toBe('written')
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toMatch(/written now/)
    await ui.unmount()
  })

  test('a refresh that fails does not change the Write result', async ($, on) => {
    const { fs } = engine(on)
    await $.session.start(START)
    fs.failReads()
    fs.write('/repo/TASKS.md', 'x')
    const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/TASKS.md', old_string: 'a', new_string: 'b' } as never)
    expect(result.result).toBe('written')
    expect(result.deny).toBeUndefined()
  })
})

describe('a /clear', () => {
  const answer = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

  test('keeps the open items and goes on with the numbering', async ($, on) => {
    const { control, store } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: OPEN, question: 'two' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    await $.session.end({ reason: 'clear', sessionId: 'session-1' } as never)
    control.clear('session-2')
    expect(String((await $.tool.call({ tool: OPEN, question: 'three' })).result)).toMatch(/^Registered as Q3,/)
    expect(String((await $.tool.call({ tool: ACTION_OPEN, action: 'test it' })).result)).toMatch(/^Registered as A2,/)
    expect(store.get('alias:session-2')).toBe('session-1')

    await $.prompt.submit(answer('[Q1 · asked 2026-11-11 10:42] ok'))
    await $.prompt.submit(answer('[A1 · done]'))
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-questions' })
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'q-2' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'q-3' })).toBeDefined()
    await ui.press({ key: 'nav-actions' })
    expect(await ui.find({ type: 'Button', key: 'a-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'a-2' })).toBeDefined()
    await ui.unmount()
  })

  test('and a reload right after it keep both', async ($, on) => {
    const { control, store } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    control.clear('session-2')
    await $.session.end({ reason: 'clear', sessionId: 'session-1' } as never)
    expect(store.get('alias:session-2')).toBe('session-1')
    await $.session.start(START)
    expect(String((await $.tool.call({ tool: OPEN, question: 'two' })).result)).toMatch(/^Registered as Q2,/)
    expect(String((await $.tool.call({ tool: ACTION_OPEN, action: 'test it' })).result)).toMatch(/^Registered as A2,/)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-questions' })
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeDefined()
    await ui.unmount()
  })

  test('that drops the session state brings the open items back from the store', async ($, on) => {
    const { control } = engine(on)
    const lost = new Map<string, { value: unknown; version: number }>()
    on('state.get', (_, e, next) => {
      const fresh = lost.get(e.key)
      return fresh ? { value: { value: fresh.value, version: fresh.version } } : next(e)
    })
    on('state.set', (_, e, next) => {
      const fresh = lost.get(e.key)
      if (!fresh) return next(e)
      if (e.ifVersion !== undefined && e.ifVersion !== fresh.version) return { value: { isSet: false, version: fresh.version } }
      lost.set(e.key, { value: e.value, version: fresh.version + 1 })
      return { value: { isSet: true, version: fresh.version + 1 } }
    })
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: OPEN, question: 'two' })

    await $.session.end({ reason: 'clear', sessionId: 'session-1' } as never)
    control.clear('session-2')
    for (const key of ['questions', 'actions', 'chain']) lost.set(key, { value: undefined, version: 0 })
    await $.prompt.submit(answer('[Q2 · asked 2026-11-11 10:42] ok'))
    expect(String((await $.tool.call({ tool: OPEN, question: 'three' })).result)).toMatch(/^Registered as Q3,/)

    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'q-2' })).toBeUndefined()
    await ui.unmount()
  })

  test('a /resume to another conversation shows only that conversation', async ($, on) => {
    const { control, store } = engine(on, {
      'open:session-9': [question(5, new Date().toISOString())],
      'seq:session-9': 5,
      'aseq:session-9': 2,
    })
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })

    await $.session.end({ reason: 'resume', sessionId: 'session-1' } as never)
    control.clear('session-9')
    expect(String((await $.tool.call({ tool: OPEN, question: 'next' })).result)).toMatch(/^Registered as Q6,/)
    expect(String((await $.tool.call({ tool: ACTION_OPEN, action: 'next' })).result)).toMatch(/^Registered as A3,/)
    expect(store.has('alias:session-9')).toBe(false)
    expect(store.get('open:session-1')).toMatchObject([{ n: 1 }])

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-questions' })
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'q-5' })).toBeDefined()
    await ui.unmount()
  })

  test('an id change with no session.end is not taken for a /clear', async ($, on) => {
    const { control, store } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    control.clear('session-3')
    expect(String((await $.tool.call({ tool: OPEN, question: 'two' })).result)).toMatch(/^Registered as Q1,/)
    expect(store.has('alias:session-3')).toBe(false)
  })

  test('a reload between a /clear and the next item still keeps the chain', async ($, on) => {
    const { control } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.session.end({ reason: 'clear', sessionId: 'session-1' } as never)
    await $.session.start(START)
    control.clear('session-2')
    await $.session.start(START)
    expect(String((await $.tool.call({ tool: OPEN, question: 'two' })).result)).toMatch(/^Registered as Q2,/)
  })

  test('a reload whose state was lost finds the numbering through the alias', async ($, on) => {
    const { store } = engine(on, { 'alias:session-1': 'session-0', 'seq:session-0': 13, 'aseq:session-0': 2, 'open:session-0': [question(13, new Date().toISOString())] })
    await $.session.start(START)
    expect(String((await $.tool.call({ tool: OPEN, question: 'next' })).result)).toMatch(/^Registered as Q14,/)
    expect(String((await $.tool.call({ tool: ACTION_OPEN, action: 'next' })).result)).toMatch(/^Registered as A3,/)
    expect(store.get('seq:session-1')).toBeUndefined()
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-questions' })
    expect(await ui.find({ type: 'Button', key: 'q-13' })).toBeDefined()
    await ui.unmount()
  })
})

describe('tasks review', () => {
  test('a file over 4 MiB is not read, says so and does not notify', async ($, on) => {
    const { fs, clock, alerts, toasts } = engine(on)
    await $.session.start(START)
    const before = fs.reads.length
    fs.write('/repo/TASKS.md', '- [x] one\n', 5 * 1024 * 1024)
    await clock.advance(15_000)
    expect(fs.reads).toHaveLength(before)
    expect(alerts).toEqual([])
    expect(toasts.filter(text => /task/.test(text))).toEqual([])

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })
    expect(await ui.find({ type: 'Text', text: /larger than 4 MiB/ })).toBeDefined()
    await ui.unmount()

    fs.write('/repo/TASKS.md', TASKS)
    await clock.advance(15_000)
    expect(toasts.filter(text => /task/.test(text))).toEqual([])
  })

  test('a poll with an unchanged stat reads nothing', async ($, on) => {
    const { fs, clock } = engine(on)
    await $.session.start(START)
    const before = fs.reads.length
    await clock.advance(20_000)
    expect(fs.reads).toHaveLength(before)
  })

  test('a file deleted and brought back unchanged notifies nothing', async ($, on) => {
    const { fs, clock, toasts, alerts } = engine(on)
    await $.session.start(START)
    fs.remove('/repo/TASKS.md')
    await clock.advance(15_000)
    fs.write('/repo/TASKS.md', TASKS)
    await clock.advance(15_000)
    expect(alerts).toEqual([])
    expect(toasts.filter(text => /task/.test(text))).toEqual([])
  })

  test('a file deleted mid-session shows as missing', async ($, on) => {
    const { fs, clock } = engine(on)
    await $.session.start(START)
    fs.remove('/repo/TASKS.md')
    await clock.advance(5_000)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })
    expect(await ui.find({ type: 'Input', key: 'tasks-path' })).toBeDefined()
    await ui.unmount()
  })

  test('a read error keeps the last text, is logged once and notifies nothing', async ($, on) => {
    const { fs, clock, toasts, logs } = engine(on)
    await $.session.start(START)
    fs.failReads()
    fs.write('/repo/TASKS.md', '- [x] one\n')
    await clock.advance(20_000)
    expect(logs.filter(line => /tasks file .* could not be read/.test(line))).toHaveLength(1)
    expect(toasts.filter(text => /task/.test(text))).toEqual([])
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(TASKS)
    await ui.unmount()
  })

  test('a stat error keeps the file as it was', async ($, on) => {
    const { fs, clock, toasts, logs } = engine(on)
    await $.session.start(START)
    fs.failStats()
    await clock.advance(15_000)
    fs.failStats(false)
    await clock.advance(15_000)
    expect(logs.filter(line => /tasks file .* could not be read/.test(line))).toHaveLength(1)
    expect(toasts.filter(text => /task/.test(text))).toEqual([])
  })

  test('an edit undone within the debounce window notifies nothing', async ($, on) => {
    const { fs, clock, alerts } = engine(on)
    await $.session.start(START)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(5_000)
    fs.write('/repo/TASKS.md', TASKS)
    await clock.advance(15_000)
    expect(alerts).toEqual([])
  })

  test('a Write through a relative or dotted path refreshes, another file does not', async ($, on) => {
    const { fs } = engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })

    fs.write('/repo/TASKS.md', '# Tasks\n- [ ] via relative\n')
    await $.tool.call({ tool: 'Write', file_path: 'docs/../TASKS.md', content: '' } as never)
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toMatch(/via relative/)

    fs.write('/repo/TASKS.md', '# Tasks\n- [ ] not yet\n')
    await $.tool.call({ tool: 'Write', file_path: '/repo/OTHER.md', content: '' } as never)
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toMatch(/via relative/)
    await ui.unmount()
  })

  test('a path with ./ in the option resolves under the root', { options: { tasksFile: './plan/../TASKS.md' } }, async ($, on) => {
    engine(on)
    await $.session.start(START)
    expect(await taskSection($ as never)).toMatch(/in \/repo\/TASKS\.md,/)
  })

  test('a leading ~ is the home directory', { options: { tasksFile: '~/notes/tasks.md' } }, async ($, on) => {
    engine(on, {}, 'main\n', false, 'ok', { '/home/me/notes/tasks.md': TASKS })
    await $.session.start(START)
    expect(await taskSection($ as never)).toMatch(/in \/home\/me\/notes\/tasks\.md,/)
  })

  test('an empty path in the setup card stores nothing', async ($, on) => {
    const { store, toasts } = engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start(START)
    const ui = await $.ui.mount(PANE)
    await ui.input({ key: 'tasks-path', text: '   ', kind: 'change' })
    await ui.press({ key: 'tasks-use' })
    expect(store.has('tasksFile:/repo')).toBe(false)
    expect(toasts).toContain('Write the path of the tasks file first.')
    await ui.unmount()
  })

  test('a duplicate checkbox label counts once', async () => {
    expect(summarizeChange('- [ ] a\n', '- [ ] a\n- [x] a\n').isNotable).toBe(false)
  })

  test('a task change while a question is open only toasts', async ($, on) => {
    const { fs, clock, toasts, opened, alerts } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'q-1' })
    const before = { opened: opened.length, alerts: alerts.length }

    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(10_000)
    expect(toasts).toContain('1 task done')
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()
    expect(opened).toHaveLength(before.opened)
    expect(alerts).toHaveLength(before.alerts)

    await ui.press({ key: 'back' })
    expect((await ui.find({ type: 'Button', key: 'nav-tasks' }))?.text).toMatch(/new/)
    await ui.press({ key: 'nav-tasks' })
    await ui.press({ key: 'nav-questions' })
    expect((await ui.find({ type: 'Button', key: 'nav-tasks' }))?.text).not.toMatch(/new/)
    await ui.unmount()
  })

  test('the tasks file is still watched after a /resume', async ($, on) => {
    const { fs, clock, toasts } = engine(on)
    await $.session.start(START)
    await $.session.end({ reason: 'resume', sessionId: 'session-1' } as never)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(10_000)
    expect(toasts).toContain('1 task done')
  })

  test('the tasks file is no longer watched once the session exits', async ($, on) => {
    const { fs, clock, toasts } = engine(on)
    await $.session.start(START)
    await $.session.end({ reason: 'other', sessionId: 'session-1' } as never)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(10_000)
    expect(toasts.filter(text => /task/.test(text))).toEqual([])
  })

  test('a tasks setup that fails still restores the questions and polls', async ($, on) => {
    const { fs, clock, logs } = engine(on, { 'open:session-1': [question(7, new Date().toISOString())], 'seq:session-1': 7 })
    fs.failRoot()
    await $.session.start(START)
    await clock.advance(10_000)
    expect(logs.some(line => /tasks file could not be set up/.test(line))).toBe(true)
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Button', key: 'q-7' })).toBeDefined()
    await ui.unmount()
    expect(String((await $.tool.call({ tool: OPEN, question: 'next' })).result)).toMatch(/^Registered as Q8,/)
  })
})

describe('menu', () => {
  test('the menu shows each section that has something and marks the open one', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    expect(await navTexts(ui)).toEqual({ 'nav-questions': '▸ ❓ Questions (1)', 'nav-tasks': '📋 Tasks 0/2' })

    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    await ui.press({ key: 'nav-questions' })
    expect(await navTexts(ui)).toEqual({
      'nav-questions': '▸ ❓ Questions (1)',
      'nav-tasks': '📋 Tasks 0/2',
      'nav-actions': '🛠 Actions (1)',
    })
    await ui.press({ key: 'nav-tasks' })
    expect((await navTexts(ui))['nav-tasks']).toBe('▸ 📋 Tasks 0/2')
    expect((await navTexts(ui))['nav-questions']).toBe('❓ Questions (1)')
    await ui.unmount()
  })

  test('a missing tasks file offers the setup until dismissed', async ($, on) => {
    engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start({ ...START, isInteractive: false })
    const ui = await $.ui.mount(PANE)
    expect(await navTexts(ui)).toEqual({ 'nav-tasks': '▸ 📋 Tasks (set up)' })
    await ui.press({ key: 'nav-tasks' })
    await ui.press({ key: 'tasks-dismiss' })
    expect(await navTexts(ui)).toEqual({})
    expect(await ui.find({ type: 'Text', text: /^Nothing pending/ })).toBeDefined()
    await ui.unmount()
  })

  test('a change in a section that is not shown is marked new until opened', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'q-1' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()
    expect((await navTexts(ui))['nav-actions']).toBe('🛠 Actions (1) (new)')
    await ui.press({ key: 'nav-actions' })
    expect((await navTexts(ui))['nav-actions']).toBe('▸ 🛠 Actions (1)')
    await ui.unmount()
  })

  test('the pane is called Agent inbox', async ($, on) => {
    const { titles } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    expect(titles).toEqual(['Agent inbox'])
  })
})

describe('notifications', () => {
  test('a new question opens the pane even when it was closed on a question', async ($, on) => {
    const { control, opened } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'q-1' })
    control.hidePane()
    const before = opened.length
    await $.tool.call({ tool: OPEN, question: 'two' })
    expect(opened).toHaveLength(before + 1)
    expect(await ui.find({ type: 'Button', key: 'q-2' })).toBeDefined()
    await ui.unmount()
  })

  test('a new question while a shown pane is on a question keeps the view', async ($, on) => {
    const { opened } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'q-1' })
    const before = opened.length
    await $.tool.call({ tool: OPEN, question: 'two' })
    expect(opened).toHaveLength(before)
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()
    await ui.unmount()
  })

  test('the new mark clears whenever the section list comes back, and only for that section', async ($, on) => {
    const { clock } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'q-1' })
    await $.tool.call({ tool: OPEN, question: 'two' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect((await navTexts(ui))['nav-questions']).toBe('▸ ❓ Questions (2) (new)')

    await ui.input({ key: 'answer-1', text: 'yes', kind: 'submit' })
    await clock.settle()
    expect(await navTexts(ui)).toMatchObject({
      'nav-questions': '▸ ❓ Questions (1)',
      'nav-actions': '🛠 Actions (1) (new)',
    })
    await ui.unmount()
  })

  test('the menu draws on every surface', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Button', key: 'nav-questions' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a new item opens its own section', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount(PANE)
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(await ui.find({ type: 'Button', key: 'a-1' })).toBeDefined()
    await $.tool.call({ tool: OPEN, question: 'one' })
    expect(await ui.find({ type: 'Button', key: 'q-1' })).toBeDefined()
    expect((await navTexts(ui))['nav-actions']).toBe('🛠 Actions (1)')
    await ui.unmount()
  })

  test('each section has its own sound gap', async ($, on) => {
    const { alerts, clock } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await clock.advance(500)
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(alerts).toHaveLength(2)
    await clock.advance(500)
    await $.tool.call({ tool: ACTION_OPEN, action: 'test it' })
    expect(alerts).toHaveLength(2)
  })

  test('one status line covers the three sections', async ($, on) => {
    const { statuses, fs, clock } = engine(on)
    await $.session.start(START)
    expect(statuses.at(-1)).toBe('📋 0/2 tasks · /questions')
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(statuses.at(-1)).toBe('❓ 1 question · 🛠 1 action · 📋 0/2 tasks · /questions')
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(5_000)
    expect(statuses.at(-1)).toBe('❓ 1 question · 🛠 1 action · 📋 1/2 tasks · /questions')
  })

  test('the status line is cleared when nothing is pending', async ($, on) => {
    const { statuses } = engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start(START)
    expect(statuses.at(-1)).toBeUndefined()
  })
})

describe('menu review', () => {
  test('a start with no questions opens on the tasks', async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount(PANE)
    expect(await navTexts(ui)).toEqual({ 'nav-tasks': '▸ 📋 Tasks 0/2' })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    await ui.unmount()
  })

  test('closing the last action moves to the next section with something', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    const ui = await $.ui.mount(PANE)
    expect((await navTexts(ui))['nav-actions']).toBe('▸ 🛠 Actions (1)')
    await $.tool.call({ tool: ACTION_CLOSE, n: 1 })
    expect(await navTexts(ui)).toEqual({ 'nav-questions': '▸ ❓ Questions (1)', 'nav-tasks': '📋 Tasks 0/2' })
    await ui.unmount()
  })

  test('nothing pending shows the empty state and no empty button', async ($, on) => {
    engine(on, {}, 'main\n', false, 'ok', {})
    await $.session.start({ ...START, isInteractive: false })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'nav-tasks' })
    await ui.press({ key: 'tasks-dismiss' })
    await $.tool.call({ tool: ACTION_CLOSE, n: 1 })
    expect(await navTexts(ui)).toEqual({})
    expect(await ui.find({ type: 'Text', text: /^Nothing pending/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(0\)/ })).toBeUndefined()
    await ui.unmount()
  })

  test('answering the last question shows the next section without a stale new mark', async ($, on) => {
    const { clock } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'q-1' })
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect((await navTexts(ui))['nav-actions']).toBe('🛠 Actions (1) (new)')
    await ui.input({ key: 'answer-1', text: 'yes', kind: 'submit' })
    await clock.settle()
    expect(await navTexts(ui)).toEqual({ 'nav-tasks': '📋 Tasks 0/2', 'nav-actions': '▸ 🛠 Actions (1)' })
    await ui.unmount()
  })

  test('a new item while an action is shown keeps the view', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'a-1' })
    await $.tool.call({ tool: OPEN, question: 'one' })
    expect(await ui.find({ type: 'Button', key: 'action-done' })).toBeDefined()
    expect((await navTexts(ui))['nav-questions']).toBe('❓ Questions (1) (new)')
    await ui.press({ key: 'back-actions' })
    await ui.press({ key: 'nav-questions' })
    expect((await navTexts(ui))['nav-questions']).toBe('▸ ❓ Questions (1)')
    await ui.unmount()
  })

  test('a /resume clears the new marks', async ($, on) => {
    const { control } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'a-1' })
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.session.end({ reason: 'resume', sessionId: 'session-1' } as never)
    control.clear('session-5')
    await $.tool.call({ tool: OPEN, question: 'other' })
    expect(Object.values(await navTexts(ui)).some(text => /new/.test(String(text)))).toBe(false)
    await ui.unmount()
  })

  test('an end that is not a /clear carries nothing over', async ($, on) => {
    const { control, store } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    await $.session.end({ reason: 'logout', sessionId: 'session-1' } as never)
    control.clear('session-4')
    expect(String((await $.tool.call({ tool: OPEN, question: 'two' })).result)).toMatch(/^Registered as Q1,/)
    expect(store.has('alias:session-4')).toBe(false)
  })

  test('a /clear in a teammate process writes no alias', async ($, on) => {
    const { control, store } = engine(on, {}, 'teammate\n')
    await $.session.start(START)
    await $.session.end({ reason: 'clear', sessionId: 'session-1' } as never)
    control.clear('session-2')
    await $.prompt.submit({ text: '[Q1 · asked 2026-11-11 10:42] ok', wait: false, origin: { kind: 'composer' } })
    expect([...store.keys()].filter(key => key.startsWith('alias:'))).toEqual([])
  })

  test('a pane that cannot open is logged and the question is still registered', async ($, on) => {
    const { control, logs, clock } = engine(on)
    await $.session.start(START)
    control.failOpen()
    const opened = await $.tool.call({ tool: OPEN, question: 'one' })
    expect(String(opened.result)).toMatch(/^Registered as Q1,/)
    await clock.settle()
    expect(logs.some(line => /pane did not open/.test(line))).toBe(true)
  })

  test('a pane whose state cannot be read keeps the human on the question', async ($, on) => {
    const { control } = engine(on)
    await $.session.start(START)
    await $.tool.call({ tool: OPEN, question: 'one' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'q-1' })
    control.failPanes()
    await $.tool.call({ tool: ACTION_OPEN, action: 'merge it' })
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()
    await ui.unmount()
  })

  test('a tasks sound that fails does not use up the tasks gap', async ($, on) => {
    const { fs, clock, alerts } = engine(on, {}, 'main\n', false, 'reject')
    await $.session.start(START)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [ ] two\n')
    await clock.advance(10_000)
    expect(alerts).toHaveLength(1)
    fs.write('/repo/TASKS.md', '# Tasks\n- [x] one\n- [x] two\n')
    await clock.advance(10_000)
    expect(alerts).toHaveLength(2)
  })
})
