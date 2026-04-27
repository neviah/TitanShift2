import { describe, expect, it, vi } from "vitest"
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
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

  it("supports scheduler template-jobs create/list/run/delete", async () => {
    const app = buildServer()
    await app.ready()

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat").mockResolvedValue({
      success: true,
      response: "template-run",
      model: "m",
      mode: "reactive",
    })

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

    const toggled = await app.inject({
      method: "POST",
      url: `/scheduler/template-jobs/${createdBody.job_id}/enabled`,
      payload: { enabled: false },
    })
    expect(toggled.statusCode).toBe(200)
    expect(toggled.json().enabled).toBe(false)

    const run = await app.inject({ method: "POST", url: `/scheduler/template-jobs/${createdBody.job_id}/run` })
    expect(run.statusCode).toBe(200)
    expect(run.json().run_id).toBeTruthy()

    const deleted = await app.inject({ method: "DELETE", url: `/scheduler/template-jobs/${createdBody.job_id}` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().deleted).toBe(true)

    await app.close()
  })

  it("supports scheduler task-stacks create/list/run/delete", async () => {
    const app = buildServer()
    await app.ready()

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat").mockResolvedValue({
      success: true,
      response: "stack-run",
      model: "m",
      mode: "reactive",
    })

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

    const toggled = await app.inject({
      method: "POST",
      url: `/scheduler/task-stacks/${createdBody.job_id}/enabled`,
      payload: { enabled: false },
    })
    expect(toggled.statusCode).toBe(200)
    expect(toggled.json().enabled).toBe(false)

    const run = await app.inject({ method: "POST", url: `/scheduler/task-stacks/${createdBody.job_id}/run` })
    expect(run.statusCode).toBe(200)
    expect(run.json().run_id).toBeTruthy()

    const deleted = await app.inject({ method: "DELETE", url: `/scheduler/task-stacks/${createdBody.job_id}` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().deleted).toBe(true)

    await app.close()
  })

  it("streams chat events through /chat/stream", async () => {
    const app = buildServer()
    await app.ready()

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat").mockResolvedValueOnce({
      success: true,
      response: "streamed text",
      model: "test-model",
      mode: "reactive",
      workflow_mode: "lightning",
      used_tools: [],
      created_paths: [],
      updated_paths: [],
      patch_summaries: [],
    })

    const streamRes = await app.inject({ method: "POST", url: "/chat/stream", payload: { prompt: "hi stream" } })
    expect(streamRes.statusCode).toBe(200)
    expect(streamRes.headers["content-type"]).toContain("text/event-stream")

    const payload = streamRes.payload
    expect(payload).toContain('"type":"start"')
    expect(payload).toContain('"type":"text_delta"')
    expect(payload).toContain('"type":"done"')
    expect(payload).toContain('"type":"eof"')

    await app.close()
  })

  it("rejects invalid request for /chat/stream", async () => {
    const app = buildServer()
    await app.ready()

    const res = await app.inject({ method: "POST", url: "/chat/stream", payload: { prompt: "" } })
    expect(res.statusCode).toBe(400)

    await app.close()
  })

  it("marks chat as failed when max_duration_ms timeout is exceeded", async () => {
    const app = buildServer()
    await app.ready()

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ success: true, response: "late", model: "m", mode: "reactive" })
          }, 30)
        }),
    )

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { prompt: "timeout test", budget: { max_duration_ms: 1 } },
    })

    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe("timeout_exceeded")

    await app.close()
  })

  it("supports /runs and /runs/:run_id introspection", async () => {
    const app = buildServer()
    await app.ready()

    vi.spyOn(adapterModule.OpenCodeHttpAdapter.prototype, "runChat").mockResolvedValueOnce({
      success: true,
      response: "run response",
      model: "m",
      mode: "reactive",
    })

    const created = await app.inject({ method: "POST", url: "/runs", payload: { prompt: "run me" } })
    expect(created.statusCode).toBe(200)
    const createdBody = created.json()
    expect(createdBody.ok).toBe(true)
    expect(createdBody.run_id).toBeTruthy()

    const list = await app.inject({ method: "GET", url: "/runs" })
    expect(list.statusCode).toBe(200)
    const listBody = list.json()
    expect(listBody.length).toBeGreaterThan(0)
    expect(listBody[0].run_id).toBeTruthy()

    const detail = await app.inject({ method: "GET", url: `/runs/${createdBody.run_id}` })
    expect(detail.statusCode).toBe(200)
    const detailBody = detail.json()
    expect(detailBody.run_id).toBe(createdBody.run_id)
    expect(detailBody.status).toBe("completed")

    await app.close()
  })

  it("persists scheduler definitions across server restarts", async () => {
    const stateFile = join(tmpdir(), `titanshift-scheduler-${randomUUID()}.json`)
    const previousStateFile = process.env.SCHEDULER_STATE_FILE
    process.env.SCHEDULER_STATE_FILE = stateFile

    try {
      const app1 = buildServer()
      await app1.ready()

      await app1.inject({
        method: "POST",
        url: "/scheduler/jobs",
        payload: {
          description: "Persisted primary",
          schedule_type: "interval",
          interval_seconds: 60,
          task_prompt: "persist job",
        },
      })

      await app1.inject({
        method: "POST",
        url: "/scheduler/template-jobs",
        payload: {
          template_id: "persist-template",
          schedule_type: "interval",
          interval_seconds: 120,
        },
      })

      await app1.inject({
        method: "POST",
        url: "/scheduler/task-stacks",
        payload: {
          task_ids: ["task-a", "task-b"],
          schedule_type: "cron",
          cron: "*/5 * * * *",
        },
      })

      await app1.close()

      const app2 = buildServer()
      await app2.ready()

      const jobs = await app2.inject({ method: "GET", url: "/scheduler/jobs" })
      const templates = await app2.inject({ method: "GET", url: "/scheduler/template-jobs" })
      const stacks = await app2.inject({ method: "GET", url: "/scheduler/task-stacks" })

      expect(jobs.statusCode).toBe(200)
      expect(templates.statusCode).toBe(200)
      expect(stacks.statusCode).toBe(200)

      expect(jobs.json().length).toBe(1)
      expect(templates.json().length).toBe(1)
      expect(stacks.json().length).toBe(1)

      await app2.close()
    } finally {
      if (previousStateFile === undefined) {
        delete process.env.SCHEDULER_STATE_FILE
      } else {
        process.env.SCHEDULER_STATE_FILE = previousStateFile
      }

      if (existsSync(stateFile)) {
        rmSync(stateFile)
      }
    }
  })
})
