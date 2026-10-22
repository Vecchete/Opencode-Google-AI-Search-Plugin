import test from "node:test"
import assert from "node:assert/strict"

import plugin from "../dist/index.js"

function fakeContext() {
  const tools = []
  const transforms = []
  return {
    tools,
    transforms,
    ctx: {
      tool: {
        async transform(callback) {
          transforms.push(callback)
          callback({ add: (definition) => tools.push(definition) })
          return { dispose: async () => {} }
        },
      },
    },
  }
}

test("the default export is an OpenCode 2 definition with a stable id", () => {
  assert.equal(plugin.id, "google-ai-search")
  assert.equal(typeof plugin.setup, "function")
})

test("setup registers google_ai_search_plus with a query-required JSON schema", async () => {
  const { tools, transforms, ctx } = fakeContext()

  const cleanup = await plugin.setup(ctx)

  assert.equal(transforms.length, 1)
  assert.equal(tools.length, 1)
  const [tool] = tools
  assert.equal(tool.name, "google_ai_search_plus")
  assert.equal(tool.input.type, "object")
  assert.deepEqual(tool.input.required, ["query"])
  assert.deepEqual(Object.keys(tool.input.properties).sort(), ["followUp", "query", "timeout"])
  assert.equal(tool.input.additionalProperties, false)
  assert.equal(typeof tool.execute, "function")
  assert.equal(typeof cleanup, "function")
  await cleanup()
})

test("server() still hands OpenCode 1 the same tool", async () => {
  assert.equal(typeof plugin.server, "function")

  const hooks = await plugin.server()

  const tool = hooks.tool.google_ai_search_plus
  assert.ok(tool, "google_ai_search_plus is missing from the OpenCode 1 tool map")
  assert.equal(typeof tool.execute, "function")
  assert.deepEqual(Object.keys(tool.args).sort(), ["followUp", "query", "timeout"])
})
