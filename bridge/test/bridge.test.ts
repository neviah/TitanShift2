import { describe, expect, it, vi } from "vitest"
import { buildServer } from "../src/server.js"
import * as adapterModule from "../src/adapters/opencodeAdapter.js"

describe("bridge api", () => {
  it("creates task through /chat and exposes it through /tasks", async () => {
    const app = buildServer()
    await app.ready()

    const runChat = vi
      .spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat")
      .mockResolvedValueOnce({
        success: true,
        response: "ok",
        model: "test-model",
        mode: "reactive",
        task_id: "runtime-overwrite",
        run_id: "runtime-overwrite",
      })

    const chat = await app.inject({ method: "POST", url: "/chat", payload: { prompt: "hello" } })
    expect(chat.statusCode).toBe(200)
    const chatBody = chat.json()
    expect(chatBody.success).toBe(true)
    expect(chatBody.task_id).toBeTruthy()

    const tasks = await app.inject({ method: "GET", url: "/tasks" })
    expect(tasks.statusCode).toBe(200)
    const tasksBody = tasks.json()
    expect(tasksBody.length).toBe(1)
    expect(tasksBody[0].status).toBe("completed")

    expect(runChat).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it("rejects empty prompt", async () => {
    const app = buildServer()
    await app.ready()
    const res = await app.inject({ method: "POST", url: "/chat", payload: { prompt: "" } })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it("cancels existing task", async () => {
    const app = buildServer()
    await app.ready()

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat").mockResolvedValueOnce({
      success: true,
      response: "ok",
      model: "test",
      mode: "reactive",
      task_id: "ignore",
      run_id: "ignore",
      session_id: "session-1",
    })

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "abortSession").mockResolvedValueOnce(true)

    const chat = await app.inject({ method: "POST", url: "/chat", payload: { prompt: "hi" } })
    const taskId = chat.json().task_id

    const cancel = await app.inject({ method: "POST", url: `/tasks/${taskId}/cancel`, payload: {} })
    expect(cancel.statusCode).toBe(200)
    expect(cancel.json().cancelled).toBe(true)

    const task = await app.inject({ method: "GET", url: `/tasks/${taskId}` })
    expect(task.json().status).toBe("cancelled")
    await app.close()
  })

  it("uses workspace set-root for chat execution", async () => {
    const app = buildServer()
    await app.ready()

    const runChat = vi
      .spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat")
      .mockResolvedValueOnce({
        success: true,
        response: "ok",
        model: "m",
        mode: "reactive",
      })

    await app.inject({
      method: "POST",
      url: "/workspace/set-root",
      payload: { path: "D:/Projects/TitanShiftV2/opencode-upstream" },
    })

    await app.inject({ method: "POST", url: "/chat", payload: { prompt: "hello" } })
    const firstCall = runChat.mock.calls[0]?.[0]
    expect(firstCall.workspaceRoot).toBe("D:/Projects/TitanShiftV2/opencode-upstream")

    await app.close()
  })

  it("honors model.default_backend when chat model is omitted", async () => {
    const app = buildServer()
    await app.ready()

    const runChat = vi
      .spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat")
      .mockResolvedValue({
        success: true,
        response: "ok",
        model: "m",
        mode: "reactive",
      })

    await app.inject({
      method: "POST",
      url: "/config",
      payload: { key: "model.default_backend", value: "anthropic/claude-sonnet-4" },
    })

    await app.inject({ method: "POST", url: "/chat", payload: { prompt: "hello" } })
    const firstCall = runChat.mock.calls[0]?.[0]
    expect(firstCall.payload.model_backend).toBe("anthropic/claude-sonnet-4")

    await app.close()
  })

  it("supports scheduler create/list/run/delete", async () => {
    const app = buildServer()
    await app.ready()

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat").mockResolvedValue({
      success: true,
      response: "scheduled",
      model: "m",
      mode: "reactive",
    })

    const created = await app.inject({
      method: "POST",
      url: "/scheduler/jobs",
      payload: {
        description: "Nightly",
        schedule_type: "interval",
        interval_seconds: 60,
        task_prompt: "run check",
      },
    })

    expect(created.statusCode).toBe(200)
    const jobId = created.json().job_id as string
    expect(jobId).toBeTruthy()

    const listed = await app.inject({ method: "GET", url: "/scheduler/jobs" })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().length).toBe(1)

    const run = await app.inject({ method: "POST", url: `/scheduler/jobs/${jobId}/run` })
    expect(run.statusCode).toBe(200)
    expect(run.json().task_id).toBeTruthy()

    const deleted = await app.inject({ method: "DELETE", url: `/scheduler/jobs/${jobId}` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().deleted).toBe(true)

    await app.close()
  })

  it("supports scheduler template-jobs create/list/delete", async () => {
    const app = buildServer()
    await app.ready()

    const created = await app.inject({
      method: "POST",
      url: "/scheduler/template-jobs",
      payload: {
        template_id: "tmpl-1",
        schedule_type: "interval",
        interval_seconds: 300,
      },
    })

    expect(created.statusCode).toBe(200)
    const createdBody = created.json()
    expect(createdBody.ok).toBe(true)
    expect(createdBody.template_id).toBe("tmpl-1")

    const listed = await app.inject({ method: "GET", url: "/scheduler/template-jobs" })
    expect(listed.statusCode).toBe(200)
    const rows = listed.json()
    expect(rows.length).toBe(1)
    expect(rows[0].template_id).toBe("tmpl-1")

    const deleted = await app.inject({ method: "DELETE", url: `/scheduler/template-jobs/${createdBody.job_id}` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().deleted).toBe(true)

    await app.close()
  })

  it("supports scheduler task-stacks create/list/delete", async () => {
    const app = buildServer()
    await app.ready()

    const created = await app.inject({
      method: "POST",
      url: "/scheduler/task-stacks",
      payload: {
        task_ids: ["task-1", "task-2"],
        schedule_type: "cron",
        cron: "*/5 * * * *",
      },
    })

    expect(created.statusCode).toBe(200)
    const createdBody = created.json()
    expect(createdBody.ok).toBe(true)
    expect(createdBody.task_count).toBe(2)

    const listed = await app.inject({ method: "GET", url: "/scheduler/task-stacks" })
    expect(listed.statusCode).toBe(200)
    const rows = listed.json()
    expect(rows.length).toBe(1)
    expect(rows[0].task_ids.length).toBe(2)

    const deleted = await app.inject({ method: "DELETE", url: `/scheduler/task-stacks/${createdBody.job_id}` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().deleted).toBe(true)

    await app.close()
  })
})
