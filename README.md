# Open Queue

![queue-power.svg](assets/queue-power.svg)

[![npm version](https://img.shields.io/npm/v/@0xsero/open-queue.svg)](https://www.npmjs.com/package/@0xsero/open-queue)

**Queue messages while OpenCode is thinking.** Instead of interrupting the model mid-response, your follow-up messages wait in line and get sent automatically when it's done.

## Why?

When you send a message while OpenCode is running:
- **Without this plugin**: Your message interrupts the current run, causing context confusion
- **With this plugin**: Your message waits, then sends automatically when the model is ready

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["@0xsero/open-queue"]
}
```

That's it. OpenCode auto-installs plugins from npm.

## Usage

By default, messages send immediately (normal behavior). To start queueing:

```
/queue hold       # Queue messages until model is done
/queue immediate  # Back to normal (sends any queued messages)
/queue status     # Check current mode
```

Or just tell the model: "Turn on message queueing"

### Environment Variable

Start in hold mode:

```bash
OPENCODE_MESSAGE_QUEUE_MODE=hold opencode
```

## Modes

| Mode | What happens |
|------|--------------|
| `immediate` | Messages send right away (default) |
| `hold` | Messages queue until the model finishes, then send in order |

## Known Issue

When you send a message in hold mode, it briefly appears sent in the UI, then gets sent again when the model finishes. The model only sees it once (after it's done), but the visual glitch exists. This is an OpenCode limitation.

## Links

- [GitHub](https://github.com/0xSero/open-queue)
- [npm](https://www.npmjs.com/package/@0xsero/open-queue)
- [Issues](https://github.com/0xSero/open-queue/issues)

## License

MIT
