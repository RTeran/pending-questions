# pending-questions

When an agent works for a long time, it asks you questions in the middle of a lot of text, and the
questions get lost. This Claude Code mod keeps what the agent needs from you in a side pane, the
**Agent inbox**, until you deal with it. The inbox has three sections:

- **Questions**: questions and decisions the agent asked you.
- **Tasks**: the agent's task list, read from a file in the project.
- **Actions**: things only you can do outside the chat, such as merging a pull request.

A row at the top of the pane shows each section that holds something, for example
`❓ Questions (2)  📋 Tasks 3/5  🛠 Actions (1)`. The open section is marked with `▸`. A section that
changed while you were looking at another one shows `(new)` until you open it. When nothing is
pending, the pane says so.

## Questions

- The agent registers each question with the `question_open` tool: the question, the context you
  need to answer it, the options and the one it recommends.
- Only secondary questions and decisions go to the pane: ones the agent can keep working without.
  A question or decision it cannot go on without still goes through `AskUserQuestion`, which stops
  the session until you answer.
- The list shows the open questions with the date and time each was asked, how long ago, and a
  separator for each day when the session runs over several days.
- Open a question to see its context, pick an option (it stays marked) or write your own answer,
  and send it. The answer reaches the agent as `[Q3 · asked 2026-11-11 10:42] your answer`.
- **Send** sends it as a new turn once the agent is idle. **Send now (to chat)** puts it in the
  prompt box, so pressing Enter delivers it into the agent's running turn.
- An answer typed in the chat that starts with `[Q3` closes the question too.
- `question_close` removes a question that no longer matters.

## Actions

An action is something the agent needs you to do outside the chat: merge a pull request, test
something by hand, provide a credential.

- The agent registers it with the `action_open` tool: what to do, the context, and a link if there
  is one. Actions are numbered on their own: `A1`, `A2`…
- Open an action to see its details and press **Done** when you have done it. The agent receives
  `[A2 · done]`.
- A message typed in the chat that starts with `[A2` marks the action done too.
- `action_close` removes an action that no longer matters.

## Tasks

The Tasks section shows the file where the agent keeps its task list. The file has no required
format; only Markdown checkboxes (`- [ ]` and `- [x]`) and headings matter for notifications.

- The file is, in this order:
  1. the path you picked in the pane for this project,
  2. the plugin's `tasksFile` option,
  3. `TASKS.md` at the project root.

  A relative path is relative to the project root, and a leading `~` is your home directory.
- If the file does not exist, the pane asks you once per session where it is. **Use this path**
  saves your answer for the project. **Not this session** hides the question until the next
  session. The pane keeps watching the path, so the section appears when the file is created.
- The pane checks the file every 5 seconds and right after the agent writes or edits it.
- A change notifies you only when it is a checkbox that changed state, a new checkbox or a new
  heading, and only once the file has kept that content for two checks. Any other edit refreshes
  the pane silently. A missing, unreadable or larger than 4 MiB file never counts as a change.
- The main session's system prompt says: "If you are the main session, not a subagent or a
  teammate, keep your task list in `<path>`, using `- [ ]` / `- [x]` checkboxes."

## Notifications

- A new question, a new action or a notable task change plays a sound and opens the pane on that
  section. If you are reading a question or an action at that moment, the pane stays where it is
  and the section's button shows `(new)`.
- Each section has its own pause between sounds: 1 second for questions and actions, 1 minute for
  tasks.
- The plugin's `sound` option picks the sound, on macOS:
  - `alert` (the default) plays the macOS alert sound you chose in System Settings > Sound. It
    ignores each terminal's own bell mute.
  - `ding` plays a short built-in tone through `afplay`.
  - `off` plays nothing.

  A sound that fails to play is written to the debug log.
- One status line sums up the three sections, for example
  `❓ 2 questions · 🛠 1 action · 📋 3/5 tasks · /questions`.

The pane's texts are in English. The agent writes questions, actions and their context in the
language you use.

## Numbering, /clear and /resume

- Open questions and actions belong to a conversation and are saved, so they survive a reload of
  the plugin.
- After a `/clear`, the open questions and actions stay in the pane and the numbering goes on
  (Q14, Q15…).
- After a `/resume`, the current conversation's questions and actions do not follow you: the pane
  shows the ones saved for the resumed conversation, with its own numbering.

## Agent teams and subagents

Only the main session, or the lead of an agent team, registers questions and actions:

- A teammate that runs in a terminal pane of its own (a `claude --agent-id …` process) does not get
  the tools at all.
- A subagent or an in-process teammate that calls `question_open` or `action_open` is refused and
  told to pass the question or action to the agent that started it.

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

- The pane opens by itself only when the terminal is at least 144 columns wide; `/questions` opens
  it at any width.
- When the content does not fit in the pane, a scrollbar on its right edge shows where you are.
- Mouse clicks inside tmux need `set -g mouse on`; otherwise use `ctrl+x tab` to enter the pane, the
  arrows and Enter.

## Development

```
claude plugin validate .
claude plugin test .
```
