# OpenCode Message Queue Plugin

[queue-power.svg](assets/queue-power.svg)

Tiny plugin that controls how user messages behave while a session is running.

Why this is useful
- Prevents mid-run interruptions: long tool runs or multi-step reasoning won't get derailed by accidental follow-ups.
- Lets you batch thoughts: drop several messages while the model is working, then deliver them in order once it finishes.
- Matches Codex-style flow: no surprise context shifts while a response is still in progress.

Modes
- `immediate` (default): send messages right away.
- `hold`: queue messages until the current run finishes, then send in order.

Visual behavior in `hold`
- When you send a message mid-run, the UI shows a `Queued (will send after current run; N pending)` placeholder.
- When the run finishes, your original message is sent once.
- A toast shows pending messages and stays until you close it (TUI only).

## Install (npm/bun)

```bash
bun add opencode-message-queue
# or: npm i opencode-message-queue
```

Add to `opencode.json`:

```json
{
  "plugin": ["opencode-message-queue"]
}
```

Slash command (optional)

```bash
mkdir -p .opencode/command
cp node_modules/opencode-message-queue/command/queue.md .opencode/command/
```

## Local (no install)

This repo already includes the plugin at `.opencode/plugin/message-queue.ts` and the command at `.opencode/command/queue.md`.

## Usage

Environment variables:

```bash
OPENCODE_MESSAGE_QUEUE_MODE=hold opencode
OPENCODE_MESSAGE_QUEUE_MODE=immediate opencode
# Keep queue toasts open until dismissed (default)
OPENCODE_MESSAGE_QUEUE_TOAST_DURATION_MS=0 opencode
```

Slash command (if installed):

```
/queue status
/queue hold
/queue immediate
```

## Limitations

- Best-effort queueing: OpenCode cannot fully defer message creation yet.
- Queue is in-memory and resets when OpenCode restarts.
