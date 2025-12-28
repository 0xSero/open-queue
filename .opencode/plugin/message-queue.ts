import { tool, type Plugin } from "@opencode-ai/plugin"
import type { TextPartInput, FilePartInput, AgentPartInput, SubtaskPartInput } from "@opencode-ai/sdk"

type ModelRef = { providerID: string; modelID: string }

type PromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

type QueuedMessage = {
  sessionID: string
  agent?: string
  model?: ModelRef
  system?: string
  tools?: Record<string, boolean>
  parts: PromptPart[]
}

type QueueMode = "immediate" | "hold"

declare const process: { env: { OPENCODE_MESSAGE_QUEUE_MODE?: string } }

let currentMode: QueueMode = (((process.env.OPENCODE_MESSAGE_QUEUE_MODE) ?? "immediate").toLowerCase() === "hold"
  ? "hold"
  : "immediate")

const busyBySession = new Map<string, boolean>()
const queueBySession = new Map<string, QueuedMessage[]>()
const draining = new Set<string>()

function enqueue(sessionID: string, item: QueuedMessage) {
  const queue = queueBySession.get(sessionID) ?? []
  queue.push(item)
  queueBySession.set(sessionID, queue)
}

function takeQueue(sessionID: string) {
  const queue = queueBySession.get(sessionID) ?? []
  queueBySession.set(sessionID, [])
  return queue
}

function toPromptPart(part: any): PromptPart | null {
  if (!part || typeof part !== "object") return null
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text } as PromptPart
    case "file":
      return {
        type: "file",
        url: part.url,
        mime: part.mime,
        filename: part.filename,
        source: part.source,
      } as PromptPart
    case "agent":
      return {
        type: "agent",
        name: part.name,
        source: part.source,
      } as PromptPart
    case "subtask":
      return {
        type: "subtask",
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
      } as PromptPart
    default:
      return null
  }
}

export default (async ({ client }) => {
  async function drain(sessionID: string) {
    if (draining.has(sessionID)) return

    const queued = takeQueue(sessionID)
    if (queued.length === 0) return

    draining.add(sessionID)
    try {
      for (const item of queued) {
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
      }
    } finally {
      draining.delete(sessionID)
    }
  }

  return {
    tool: {
      queue: tool({
        description: "Control message queue mode. Use 'hold' to queue messages until session is idle, 'immediate' to send messages right away, or 'status' to check current mode and queue size.",
        args: {
          action: tool.schema.enum(["hold", "immediate", "status"]).describe("Action to perform: 'hold' queues messages, 'immediate' sends them right away, 'status' shows current state"),
        },
        async execute({ action }, ctx) {
          if (action === "status") {
            const queueSize = queueBySession.get(ctx.sessionID)?.length ?? 0
            const busy = busyBySession.get(ctx.sessionID) ?? false
            return `Mode: ${currentMode}\nQueued messages: ${queueSize}\nSession busy: ${busy}`
          }
          currentMode = action
          if (action === "immediate") {
            await drain(ctx.sessionID)
          }
          return `Message queue mode set to: ${action}`
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

      const parts = output.parts.map(toPromptPart).filter((part): part is PromptPart => part !== null)
      enqueue(input.sessionID, {
        sessionID: input.sessionID,
        agent: input.agent ?? output.message.agent,
        model: input.model ?? output.message.model,
        system: output.message.system,
        tools: output.message.tools,
        parts,
      })

      for (const part of output.parts) {
        if (part.type === "text") {
          const textPart = part as { ignored?: boolean }
          textPart.ignored = true
        }
      }
    },
  }
}) satisfies Plugin
