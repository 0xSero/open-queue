# Message Queue Plugin for OpenCode

[![npm version](https://img.shields.io/npm/v/open-queue.svg)](https://www.npmjs.com/package/open-queue)

Control how messages behave while a session is running. Queue them up or send them immediately.

## NOTE

Be aware that when a message is sent while model is running it looks like it's sent, then when the model is really done it gets sent again. 

I can't fix that yet, but the functionality does work the model won't see the 2nd message until after it's done

## Modes

| Mode | Behavior |
|------|----------|
| `immediate` | Messages are sent right away (default) |
| `hold` | Messages are queued until the current run finishes, then sent in order |

## Installation

### From npm

```bash
# In your project's .opencode directory
cd .opencode
bun add open-queue
```

Then add to your `.opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["open-queue"]
}
```

Optionally, copy the slash command to your project:

```bash
cp node_modules/open-queue/command/queue.md .opencode/command/
```

### From source

Clone this repo and run OpenCode directly:

```bash
git clone https://github.com/0xSero/open-queue.git
cd open-queue
opencode
```

Or copy `.opencode/` to your project:

```bash
cp -r open-queue/.opencode your-project/
cd your-project/.opencode && bun install
```

## Usage

### Slash Command

The easiest way to control the queue is with the `/queue` command:

```
/queue status     # Check current mode and queue size
/queue hold       # Start queueing messages
/queue immediate  # Send messages immediately (drains any queued)
```

### Environment Variable

Set the initial mode via environment variable:

```bash
# Start in hold mode
OPENCODE_MESSAGE_QUEUE_MODE=hold opencode

# Start in immediate mode (default)
OPENCODE_MESSAGE_QUEUE_MODE=immediate opencode
```

### Programmatic (via LLM)

The plugin exposes a `queue` tool that the LLM can invoke directly:

- "Set queue mode to hold"
- "Check queue status"
- "Switch to immediate mode"

## How It Works

### Hold Mode

When in `hold` mode:

1. Incoming messages are intercepted by the `chat.message` hook
2. Message parts are converted and stored in a per-session queue
3. Text parts are marked as `ignored` to hide them from the current run
4. When the session becomes idle (`session.status` or `session.idle` events), queued messages are drained in order via `client.session.prompt()`

### Immediate Mode

When in `immediate` mode:

1. Messages pass through without modification
2. Any existing queued messages are drained when switching from hold to immediate

## API

### Tool: `queue`

| Action | Description |
|--------|-------------|
| `status` | Returns current mode, queue size, and session busy state |
| `hold` | Sets mode to hold (queue messages) |
| `immediate` | Sets mode to immediate and drains any queued messages |

### Events Handled

- `session.status` - Tracks busy/idle state, drains queue when idle
- `session.idle` - Alternative idle detection, drains queue

### Hooks Used

- `chat.message` - Intercepts messages in hold mode, queues them, marks text as ignored

## Limitations

- **Best-effort queueing**: OpenCode does not yet allow plugins to fully defer message creation. The plugin hides text content but non-text attachments may still be sent.
- **Global mode**: The mode is global across all sessions. Per-session mode could be added if needed.
- **Plugin scope**: Queued messages are lost if OpenCode restarts.

## Publishing

```bash
# Build and publish
bun run build
npm publish
```

## License

MIT
