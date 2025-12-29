import { tool, type Plugin } from "@opencode-ai/plugin"
import type {
  AgentPartInput,
  FilePartInput,
  Part,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk"
import fs from "fs"


type ModelRef = { providerID: string; modelID: string }

type PromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

type QueuePriority = "low" | "normal" | "high" | any

type QueuedMessage = {
  sessionID: string
  agent?: string
  model?: ModelRef
  system?: string
  tools?: Record<string, boolean>
  parts: PromptPart[]
  preview: string
  priority: QueuePriority
  enqueuedAt: number
  status: "queued" | "sending" | "sent"

}

type QueueMode = "immediate" | "hold"

type Env = {
  OPENCODE_MESSAGE_QUEUE_MODE?: string
  OPENCODE_MESSAGE_QUEUE_TOAST_DURATION_MS?: string
  OPENCODE_MESSAGE_QUEUE_EMPTY_TOAST_DURATION_MS?: string
}

const ENV: Env = typeof process === "undefined" ? {} : (process.env as Env)

const DEFAULT_MODE: QueueMode =
  (ENV.OPENCODE_MESSAGE_QUEUE_MODE ?? "immediate").toLowerCase() === "hold" ? "hold" : "immediate"
const QUEUED_TEXT_PREFIX = "Queued (will send after current run)"
const TOAST_MAX_PREVIEWS = 3
const TOAST_DURATION_MS = (() => {
  const raw = ENV.OPENCODE_MESSAGE_QUEUE_TOAST_DURATION_MS
  if (!raw) return 86_400_000
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 86_400_000
})()
const EMPTY_TOAST_DURATION_MS = (() => {
  const raw = ENV.OPENCODE_MESSAGE_QUEUE_EMPTY_TOAST_DURATION_MS
  if (!raw) return 4_000
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 4_000
})()
const INTERNAL_METADATA_KEY = "__open_queue_internal"

const PRIORITY_REGEX = /^\s*\[\s*priority\s*:\s*(low|normal|high)\s*\]\s*/i

function extractPriority(
  parts: PromptPart[],
): { priority: QueuePriority; parts: PromptPart[] } {
  const firstText = parts.find((p) => p.type === "text")
  if (!firstText || firstText.type !== "text") {
    return { priority: "normal", parts }
  }

  const match = firstText.text.match(PRIORITY_REGEX)
  if (!match) {
    return { priority: "normal", parts }
  }

  const priority = match[1].toLowerCase() as QueuePriority

  const cleanedText = firstText.text.replace(PRIORITY_REGEX, "")

  const cleanedParts = parts.map((p) =>
    p === firstText ? { ...p, text: cleanedText } : p,
  )

  return { priority, parts: cleanedParts }
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

function getPendingCount(queue: QueuedMessage[]) {
  return queue.filter((item) => item.status !== "sent").length
}

function priorityRank(priority: QueuePriority): number {
  switch (priority) {
    case "high":
      return 2
    case "normal":
      return 1
    case "low":
      return 0
    default:
      return 0
  }
}

function buildToastMessage(queue: QueuedMessage[]) {
  const pendingCount = getPendingCount(queue)
  const previewCount = Math.min(queue.length, TOAST_MAX_PREVIEWS)
  const previews = queue.slice(0, previewCount).map((item, index) => {
    const text = `[${item.priority}] ${buildPreview(item)}`
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

function buildEmptyToastMessage() {
  return "Queue empty. All queued messages sent."
}

function isInternalMessage(parts: Part[]) {
  return parts.some(
    (part) => part.type === "text" && Boolean(part.metadata?.[INTERNAL_METADATA_KEY]),
  )
}

function markInternalParts(parts: PromptPart[]) {
  let hasText = false
  const marked = parts.map((part) => {
    if (part.type !== "text") return part
    hasText = true
    const existing = part.metadata ?? {}
    return {
      ...part,
      metadata: { ...existing, [INTERNAL_METADATA_KEY]: true },
    }
  })
  if (hasText) return marked
  const markerPart: TextPartInput = {
    type: "text",
    text: "",
    synthetic: true,
    ignored: true,
    metadata: { [INTERNAL_METADATA_KEY]: true },
  }
  return [markerPart, ...marked]
}

export const MessageQueuePlugin: Plugin = async ({ client }) => {
  let currentMode: QueueMode = DEFAULT_MODE
  const busyBySession = new Map<string, boolean>()
  const queueBySession = new Map<string, QueuedMessage[]>()
  const draining = new Set<string>()
  const lastQueueCommandBySession = new Map<string, { messageID: string }>()

  function getQueue(sessionID: string) {
    const existing = queueBySession.get(sessionID)
    if (existing) return existing
    const next: QueuedMessage[] = []
    queueBySession.set(sessionID, next)
    return next
  }

  function enqueue(sessionID: string, item: QueuedMessage) {
    const queue = getQueue(sessionID)
    queue.push(item)
  }

  async function showQueueToast(sessionID: string, options?: { forceEmpty?: boolean }) {
    const queue = queueBySession.get(sessionID) ?? []
    const pending = getPendingCount(queue)
    const shouldForceEmpty = options?.forceEmpty === true

    if (queue.length === 0 && !shouldForceEmpty) return

    const isEmpty = pending === 0
    const variant = isEmpty ? "success" : "info"
    const duration = isEmpty ? EMPTY_TOAST_DURATION_MS : TOAST_DURATION_MS
    const message = isEmpty ? buildEmptyToastMessage() : buildToastMessage(queue)

    await client.tui.showToast({
      body: {
        title: "Message Queue",
        message,
        variant,
        duration,
      },
    })
  }

  async function drain(sessionID: string) {
    if (draining.has(sessionID)) return

    const queue = queueBySession.get(sessionID) ?? []
    if (queue.length === 0) return

    draining.add(sessionID)
    try {
      let showedEmptyToast = false
      while (true) {
        const next = queue
          .filter((item) => item.status === "queued")
          .sort(
            (a, b) =>
              priorityRank(b.priority) - priorityRank(a.priority) ||
              a.enqueuedAt - b.enqueuedAt,
          )[0]
        if (!next) break

        next.status = "sending"
        try {
          await showQueueToast(sessionID)
        } catch {
          // TUI may not be active (e.g., API-only usage).
        }

        try {
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              agent: next.agent,
              model: next.model,
              system: next.system,
              tools: next.tools,
              parts: markInternalParts(next.parts),
            },
          })
          next.status = "sent"
        } catch (error) {
          next.status = "queued"
          throw error
        }

        try {
          await showQueueToast(sessionID)
        } catch {
          // TUI may not be active (e.g., API-only usage).
        }
        if (getPendingCount(queue) === 0) showedEmptyToast = true
      }

      queueBySession.set(sessionID, [])
      try {
        if (!showedEmptyToast) {
          await showQueueToast(sessionID, { forceEmpty: true })
        }
      } catch {
        // TUI may not be active (e.g., API-only usage).
      }
    } finally {
      draining.delete(sessionID)
    }
  }

  return {
    tool: {
      queue: tool({
        description:
          "Control message queue mode. Use 'hold' to queue messages until the session is idle, 'immediate' to send right away, or 'status' to check current state. Only switch modes when explicitly requested.",
        args: {
          action: tool.schema
            .enum(["hold", "immediate", "status"])
            .optional()
            .describe("Action to perform: hold, immediate, or status"),
        },
        async execute({ action }, ctx) {
          const nextAction = action ?? "status"
          const queue = queueBySession.get(ctx.sessionID) ?? []
          const queueSize = getPendingCount(queue)
          const busy = busyBySession.get(ctx.sessionID) ?? false

          if (nextAction === "status") {
            return `Mode: ${currentMode}\nQueued messages: ${queueSize}\nSession busy: ${busy}`
          }

          if (nextAction === "immediate") {
            const lastCommand = lastQueueCommandBySession.get(ctx.sessionID)
            const fromCommand = lastCommand?.messageID === ctx.messageID
            if (!fromCommand) {
              return [
                "Ignoring automatic queue release. Use /queue immediate to switch modes.",
                `Mode: ${currentMode}`,
                `Queued messages: ${queueSize}`,
                `Session busy: ${busy}`,
              ].join("\n")
            }
            lastQueueCommandBySession.delete(ctx.sessionID)
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
      if (event.type === "command.executed") {
        const { name, sessionID, messageID } = event.properties
        if (name === "queue") {
          lastQueueCommandBySession.set(sessionID, { messageID })
        }
        return
      }

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
      if (isInternalMessage(output.parts)) return

      const existingQueue = queueBySession.get(input.sessionID)
      const pendingCount = existingQueue ? getPendingCount(existingQueue) : 0
      const busy = busyBySession.get(input.sessionID) ?? false
      const shouldQueue = busy || draining.has(input.sessionID) || pendingCount >= 0//Set to >= to ensure first message is also included in the queue toast
      if (!shouldQueue) return

      const originalParts = [...output.parts]
      const queuedParts = originalParts.map(toPromptPart).filter((part): part is PromptPart => part !== null)
      
      const { priority, parts: cleanedParts } = extractPriority(queuedParts)
      const preview = extractPreview(queuedParts)

      enqueue(input.sessionID, {
        sessionID: input.sessionID,
        agent: input.agent ?? output.message.agent,
        model: input.model ?? output.message.model,
        system: output.message.system,
        tools: output.message.tools,
        parts: cleanedParts,
        priority,
        enqueuedAt: Date.now(),
        preview,
        status: "queued",
      })

      const queueSize = getPendingCount(queueBySession.get(input.sessionID) ?? [])
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
