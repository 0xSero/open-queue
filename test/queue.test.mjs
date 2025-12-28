import { expect, test } from "bun:test"

process.env.OPENCODE_MESSAGE_QUEUE_MODE = "hold"

const { MessageQueuePlugin } = await import("../dist/index.js")

const flush = () => new Promise((resolve) => setImmediate(resolve))

function createFakeClient() {
  const promptCalls = []
  const promptResolvers = []
  const toastCalls = []

  const session = {
    prompt: (args) => {
      promptCalls.push(args)
      let resolve
      const promise = new Promise((res) => {
        resolve = res
      })
      promptResolvers.push(() => resolve({ ok: true }))
      return promise
    },
  }

  const tui = {
    showToast: (args) => {
      toastCalls.push(args)
      return Promise.resolve()
    },
  }

  return {
    client: { session, tui },
    promptCalls,
    toastCalls,
    resolvePrompt: (index) => {
      const resolver = promptResolvers[index]
      if (resolver) resolver()
    },
  }
}

function createChatPayload(sessionID, messageID, text) {
  const message = {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
  }
  const parts = [
    {
      id: `${messageID}-part`,
      sessionID,
      messageID,
      type: "text",
      text,
    },
  ]

  return {
    input: { sessionID, messageID, agent: "user", model: { providerID: "test", modelID: "test" } },
    output: { message, parts },
  }
}

test("queues messages while busy and replaces UI parts", async () => {
  const { client, promptCalls, toastCalls } = createFakeClient()
  const hooks = await MessageQueuePlugin({ client })
  const sessionID = "session-1"

  await hooks.event?.({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
  })

  const { input, output } = createChatPayload(sessionID, "msg-1", "first")
  await hooks["chat.message"]?.(input, output)

  expect(promptCalls.length).toBe(0)
  expect(output.parts.length).toBe(1)
  expect(output.parts[0].type).toBe("text")
  expect(output.parts[0].text).toContain("Queued")
  expect(toastCalls.length).toBeGreaterThan(0)
})

test("queues messages during drain and sends in order", async () => {
  const { client, promptCalls, toastCalls, resolvePrompt } = createFakeClient()
  const hooks = await MessageQueuePlugin({ client })
  const sessionID = "session-2"

  await hooks.event?.({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
  })

  const first = createChatPayload(sessionID, "msg-1", "first")
  const second = createChatPayload(sessionID, "msg-2", "second")
  await hooks["chat.message"]?.(first.input, first.output)
  await hooks["chat.message"]?.(second.input, second.output)

  const drainPromise = hooks.event?.({
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
  })
  await flush()
  expect(promptCalls.length).toBe(1)

  const third = createChatPayload(sessionID, "msg-3", "third")
  await hooks["chat.message"]?.(third.input, third.output)
  expect(promptCalls.length).toBe(1)

  resolvePrompt(0)
  await flush()
  expect(promptCalls.length).toBe(2)

  resolvePrompt(1)
  await flush()
  expect(promptCalls.length).toBe(3)

  resolvePrompt(2)
  await drainPromise

  const sentOrder = promptCalls.map((call) => call.body.parts.find((part) => part.type === "text")?.text)
  expect(sentOrder).toEqual(["first", "second", "third"])

  const lastToast = toastCalls.at(-1)?.body?.message ?? ""
  expect(lastToast).toContain("Queue empty")
})

test("blocks automatic immediate mode changes without a /queue command", async () => {
  const { client } = createFakeClient()
  const hooks = await MessageQueuePlugin({ client })
  const sessionID = "session-3"

  const immediateResult = await hooks.tool.queue.execute(
    { action: "immediate" },
    { sessionID, messageID: "msg-1", agent: "assistant", abort: new AbortController().signal },
  )
  expect(immediateResult).toContain("Ignoring automatic queue release")

  const statusResult = await hooks.tool.queue.execute(
    { action: "status" },
    { sessionID, messageID: "msg-2", agent: "assistant", abort: new AbortController().signal },
  )
  expect(statusResult).toContain("Mode: hold")

  await hooks.event?.({
    event: {
      type: "command.executed",
      properties: { name: "queue", sessionID, arguments: "immediate", messageID: "msg-3" },
    },
  })

  const commandResult = await hooks.tool.queue.execute(
    { action: "immediate" },
    { sessionID, messageID: "msg-3", agent: "assistant", abort: new AbortController().signal },
  )
  expect(commandResult).toContain("Message queue mode set to: immediate")
})
