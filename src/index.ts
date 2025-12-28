import { tool, type Plugin } from "@opencode-ai/plugin"
import type {
  AgentPartInput,
  FilePartInput,
  Part,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk"

type ModelRef = { providerID: string; modelID: string }

type PromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

type QueuedMessage = {
  sessionID: string
  agent?: string
  model?: ModelRef
  system?: string
  tools?: Record<string, boolean>
  parts: PromptPart[]
  preview: string
  status: "queued" | "sending" | "sent"
}

type QueueMode = "immediate" | "hold"

type Env = {
  OPENCODE_MESSAGE_QUEUE_MODE?: string
  OPENCODE_MESSAGE_QUEUE_TOAST_DURATION_MS?: string
}

const ENV: Env = typeof process === "undefined" ? {} : (process.env as Env)

let currentMode: QueueMode =
  (ENV.OPENCODE_MESSAGE_QUEUE_MODE ?? "immediate").toLowerCase() === "hold" ? "hold" : "immediate"
const QUEUED_TEXT_PREFIX = "Queued (will send after current run)"
const TOAST_MAX_PREVIEWS = 3
const TOAST_DURATION_MS = (() => {
  const raw = ENV.OPENCODE_MESSAGE_QUEUE_TOAST_DURATION_MS
  if (!raw) return 86_400_000
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 86_400_000
})()

const busyBySession = new Map<string, boolean>()
const queueBySession = new Map<string, QueuedMessage[]>()
const draining = new Set<string>()

function enqueue(sessionID: string, item: QueuedMessage) {
  const queue = queueBySession.get(sessionID) ?? []
  queue.push(item)
  queueBySession.set(sessionID, queue)
}

function toPromptPart(part: Part): PromptPart | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text }
    case "file":
      return {
        type: "file",
        url: part.url,
        mime: part.mime,
        filename: part.filename,
        source: part.source,
      }
    case "agent":
      return {
        type: "agent",
        name: part.name,
        source: part.source,
      }
    case "subtask":
      return {
        type: "subtask",
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
      }
    default:
      return null
  }
}

function makePlaceholder(parts: Part[], count: number) {
  const template = parts.find((part) => part.type === "text") ?? parts[0]
  if (!template) return null

  return {
    id: template.id,
    sessionID: template.sessionID,
    messageID: template.messageID,
    type: "text",
    text: `${QUEUED_TEXT_PREFIX}; ${count} pending`,
    synthetic: true,
    ignored: true,
  } satisfies Part
}

function truncatePreview(text: string) {
  const trimmed = text.replace(/\s+/g, " ").trim()
  if (trimmed.length <= 28) return trimmed
  return `${trimmed.slice(0, 25)}...`
}

function buildPreview(item: QueuedMessage) {
  return truncatePreview(item.preview)
}

function extractPreview(parts: PromptPart[]) {
  const text = parts.find((part) => part.type === "text")
  if (text && "text" in text) {
    return truncatePreview(text.text)
  }
  if (parts.some((part) => part.type === "file")) return "[file]"
  if (parts.some((part) => part.type === "agent")) return "[agent]"
  if (parts.some((part) => part.type === "subtask")) return "[subtask]"
  return "[message]"
}

function buildToastMessage(sessionID: string) {
  const queue = queueBySession.get(sessionID) ?? []
  const pendingCount = queue.filter((item) => item.status !== "sent").length
  const previewCount = Math.min(queue.length, TOAST_MAX_PREVIEWS)
  const previews = queue.slice(0, previewCount).map((item, index) => {
    const text = buildPreview(item)
    if (item.status === "sent") return ` ${index + 1}. [x] ~~${text}~~`
    if (item.status === "sending") return ` ${index + 1}. [>] ${text}`
    return ` ${index + 1}. [ ] ${text}`
  })
  const current = queue.find((item) => item.status === "sending")?.preview
  const currentLine = current ? `Current: ${truncatePreview(current)}\n` : ""
  const more = queue.length > previewCount ? `\n +${queue.length - previewCount} more` : ""
  const header = `Message Queue (${pendingCount} pending)`
  const rule = "-".repeat(header.length)
  const body = previews.length ? previews.join("\n") : " (empty)"
  return `${header}\n${rule}\n${currentLine}${body}${more}\nUse /queue status to check details`
}

function getPendingCount(sessionID: string) {
  const queue = queueBySession.get(sessionID) ?? []
  return queue.filter((item) => item.status !== "sent").length
}

export const MessageQueuePlugin: Plugin = async ({ client }) => {
  async function showQueueToast(sessionID: string) {
    const queue = queueBySession.get(sessionID) ?? []
    if (queue.length === 0) return
    const pending = getPendingCount(sessionID)
    const variant = pending === 0 ? "success" : "info"
    const duration = pending === 0 ? 1500 : TOAST_DURATION_MS

    await client.tui.showToast({
      body: {
        title: "Message Queue",
        message: buildToastMessage(sessionID),
        variant,
        duration,
      },
    })
  }

  async function drain(sessionID: string) {
    if (draining.has(sessionID)) return

    const queued = queueBySession.get(sessionID) ?? []
    if (queued.length === 0) return

    draining.add(sessionID)
    try {
      for (const item of queued) {
        item.status = "sending"
        try {
          await showQueueToast(sessionID)
        } catch {
          // TUI may not be active (e.g., API-only usage).
        }
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            agent: item.agent,
            model: item.model,
            system: item.system,
            tools: item.tools,
            parts: item.parts,
          },
        })
        item.status = "sent"
        try {
          await showQueueToast(sessionID)
        } catch {
          // TUI may not be active (e.g., API-only usage).
        }
      }
      try {
        await showQueueToast(sessionID)
      } catch {
        // TUI may not be active (e.g., API-only usage).
      }
      queueBySession.set(sessionID, [])
    } finally {
      draining.delete(sessionID)
    }
  }

  return {
    tool: {
      queue: tool({
        description:
          "Control message queue mode. Use 'hold' to queue messages until session is idle, 'immediate' to send right away, or 'status' to check current state.",
        args: {
          action: tool.schema
            .enum(["hold", "immediate", "status"])
            .optional()
            .describe("Action to perform: hold, immediate, or status"),
        },
        async execute({ action }, ctx) {
          const nextAction = action ?? "status"
          if (nextAction === "status") {
            const queueSize = getPendingCount(ctx.sessionID)
            const busy = busyBySession.get(ctx.sessionID) ?? false
            return `Mode: ${currentMode}\\nQueued messages: ${queueSize}\\nSession busy: ${busy}`
          }

          currentMode = nextAction
          if (nextAction === "immediate") {
            await drain(ctx.sessionID)
          }
          return `Message queue mode set to: ${currentMode}`
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        const busy = status.type !== "idle"
        busyBySession.set(sessionID, busy)
        if (!busy && currentMode === "hold") {
          await drain(sessionID)
        }
        return
      }

      if (event.type === "session.idle") {
        const { sessionID } = event.properties
        busyBySession.set(sessionID, false)
        if (currentMode === "hold") {
          await drain(sessionID)
        }
      }
    },

    "chat.message": async (input, output) => {
      if (currentMode !== "hold") return
      if (draining.has(input.sessionID)) return
      if (busyBySession.get(input.sessionID) !== true) return

      const originalParts = [...output.parts]
      const queuedParts = originalParts.map(toPromptPart).filter((part): part is PromptPart => part !== null)
      const preview = extractPreview(queuedParts)

      enqueue(input.sessionID, {
        sessionID: input.sessionID,
        agent: input.agent ?? output.message.agent,
        model: input.model ?? output.message.model,
        system: output.message.system,
        tools: output.message.tools,
        parts: queuedParts,
        preview,
        status: "queued",
      })

      const queueSize = getPendingCount(input.sessionID)
      const placeholder = makePlaceholder(originalParts, queueSize)
      if (placeholder) {
        output.parts.length = 0
        output.parts.push(placeholder)
      }

      try {
        await showQueueToast(input.sessionID)
      } catch {
        // TUI may not be active (e.g., API-only usage).
      }
    },
  }
}
