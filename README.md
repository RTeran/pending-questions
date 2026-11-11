# pending-questions

When an agent works for a long time, it asks you questions in the middle of a lot of text, and the
questions get lost. This Claude Code mod keeps every open question in a side pane until you answer it.

- The agent registers each question with the `question_open` tool: the question, the context you
  need to answer it, the options and the one it recommends.
- The pane lists the open questions with the date and time each was asked, how long ago, and a
  separator for each day when the session runs over several days.
- Open a question to see its context, pick an option (it stays marked) or write your own answer,
  and send it. The answer reaches the agent as `[Q3 · preguntada 11/11/2026 10:42] your answer`.
- **Enviar** sends it as a new turn once the agent is idle. **Enviar ya (al chat)** puts it in the
  prompt box, so pressing Enter delivers it into the agent's running turn.
- An answer typed in the chat that starts with `[Q3` closes the question too.
- `question_close` removes a question that no longer matters. `/preguntas` opens the pane.

The pane's texts are in Spanish.

## Agent teams and subagents

Only the main session, or the lead of an agent team, registers questions:

- A teammate that runs in a terminal pane of its own (a `claude --agent-id …` process) does not get
  the tools at all.
- A subagent or an in-process teammate that calls `question_open` is refused and told to pass the
  question to the agent that started it.

## Install

At the prompt of a terminal session:

```
/plugin install pending-questions --marketplace RTeran/pending-questions
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install pending-questions --marketplace RTeran/pending-questions
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add
marketplace with `RTeran/pending-questions`, then Add plugin.

## Notes

- The pane opens by itself only when the terminal is at least 144 columns wide; `/preguntas` opens
  it at any width.
- Open questions are kept per session, so they survive a reload and a resume.
- Mouse clicks inside tmux need `set -g mouse on`; otherwise use `ctrl+x tab` to enter the pane, the
  arrows and Enter.

## Development

```
claude plugin validate .
claude plugin test .
```
