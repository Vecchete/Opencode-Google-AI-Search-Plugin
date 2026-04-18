import test from "node:test"
import assert from "node:assert/strict"

import { registerAbortCleanup } from "../dist/index.js"

test("registerAbortCleanup triggers the callback exactly once on abort", () => {
  const controller = new AbortController()
  let calls = 0

  const dispose = registerAbortCleanup(controller.signal, () => {
    calls += 1
  })

  controller.abort()
  controller.abort()
  dispose()

  assert.equal(calls, 1)
})

test("registerAbortCleanup cleanup detaches the listener before abort", () => {
  const controller = new AbortController()
  let calls = 0

  const dispose = registerAbortCleanup(controller.signal, () => {
    calls += 1
  })

  dispose()
  controller.abort()

  assert.equal(calls, 0)
})
