export type Option = { key: string; label: string }

export type Question = {
  n: number
  question: string
  context: string
  options: Option[]
  recommended?: string
  askedAt: string
  draft?: string
  queuedAt?: string
}

export type Action = {
  n: number
  action: string
  context: string
  url?: string
  askedAt: string
  queuedAt?: string
}

export type View =
  | { kind: 'list' }
  | { kind: 'question'; n: number }
  | { kind: 'actions' }
  | { kind: 'action'; n: number }

export type ScrollCache = { key: string; contentRows: number }

declare module 'claude-code' {
  interface PluginState {
    'pending-questions': {
      questions: Shaped<Question[]>
      actions: Shaped<Action[]>
      view: Shaped<View>
      now: string
      scroll: Shaped<ScrollCache>
    }
  }
}
