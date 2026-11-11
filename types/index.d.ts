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

export type View = { kind: 'list' } | { kind: 'question'; n: number }

declare module 'claude-code' {
  interface PluginState {
    'pending-questions': {
      questions: Shaped<Question[]>
      view: Shaped<View>
      now: string
    }
  }
}
