import Fastify from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { OpenCodeHttpAdapter } from "./adapters/opencodeAdapter.js"
import { TaskStore } from "./store/taskStore.js"
import { SchedulerStore } from "./store/schedulerStore.js"
import type { ChatRequest, RuntimeSettings, SchedulerTickResult, TaskRecord } from "./types.js"

const ChatRequestSchema = z.object({
  prompt: z.string().min(1),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
  model_backend: z.string().optional(),
  workflow_mode: z.enum(["lightning", "superpowered"]).optional(),
  spec_approved: z.boolean().optional(),
  plan_approved: z.boolean().optional(),
  plan_tasks: z.array(z.record(z.unknown())).optional(),
  budget: z
    .object({
      max_steps: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
      max_duration_ms: z.number().int().positive().optional(),
    })
    .optional(),
})

const ConfigUpdateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
})

const SchedulerJobCreateSchema = z.object({
  job_id: z.string().optional(),
  description: z.string().default(""),
  schedule_type: z.enum(["interval", "cron"]),
  interval_seconds: z.number().int().positive().optional(),
  cron: z.string().optional(),
  enabled: z.boolean().optional(),
  timeout_s: z.number().positive().optional(),
  max_failures: z.number().int().nonnegative().optional(),
  task_prompt: z.string().min(1),
  model_backend: z.string().optional(),
  workflow_mode: z.enum(["lightning", "superpowered"]).optional(),
})

const SchedulerEnabledSchema = z.object({
  enabled: z.boolean(),
})

export function buildServer() {
  const app = Fastify({ logger: true })
  const taskStore = new TaskStore()
  const schedulerStore = new SchedulerStore()

  let activeWorkspaceRoot = process.cwd()
  let settings: RuntimeSettings = {
    model_default_backend: "opencode/default",
    provider_default_model: "opencode/default",
  }

  const adapter = new OpenCodeHttpAdapter(process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096")

  app.get("/health", async () => ({ ok: true, root: activeWorkspaceRoot }))

  app.post("/chat", async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: "invalid_request", details: parsed.error.issues })
    }

    const payload: ChatRequest = {
      ...parsed.data,
      model_backend: parsed.data.model_backend ?? settings.model_default_backend,
    }
    const taskId = randomUUID()
    const runId = randomUUID()
    const now = new Date().toISOString()

    const baseTask: TaskRecord = {
      task_id: taskId,
      run_id: runId,
      description: payload.prompt,
      status: "running",
      created_at: now,
      started_at: now,
      output: {},
      workspace_root: activeWorkspaceRoot,
    }
    taskStore.upsert(baseTask)

    try {
      const result = await adapter.runChat({
        taskId,
        runId,
        workspaceRoot: activeWorkspaceRoot,
        payload,
      })

      taskStore.updateStatus(taskId, "completed", {
        completed_at: new Date().toISOString(),
        success: result.success,
        error: result.error,
        output: {
          ...result,
          session_id: result.session_id,
          provider_model: settings.provider_default_model,
        },
      })

      return {
        ...result,
        task_id: taskId,
        run_id: runId,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error"
      taskStore.updateStatus(taskId, "failed", {
        completed_at: new Date().toISOString(),
        success: false,
        error: message,
        output: { error: message },
      })
      return reply.code(500).send({
        success: false,
        response: "",
        model: "unknown",
        mode: "error",
        task_id: taskId,
        run_id: runId,
        error: message,
      })
    }
  })

  app.get("/tasks", async () => taskStore.list())

  app.get<{ Params: { task_id: string } }>("/tasks/:task_id", async (req, reply) => {
    const task = taskStore.get(req.params.task_id)
    if (!task) {
      return reply.code(404).send({ detail: "Task not found" })
    }
    return task
  })

  app.post<{ Params: { task_id: string } }>("/tasks/:task_id/cancel", async (req, reply) => {
    const task = taskStore.get(req.params.task_id)
    if (!task) {
      return reply.code(404).send({ task_id: req.params.task_id, cancelled: false, was_running: false })
    }

    const sessionId = typeof task.output.session_id === "string" ? task.output.session_id : undefined
    const aborted = sessionId ? await adapter.abortSession(sessionId, task.workspace_root) : false

    taskStore.updateStatus(req.params.task_id, "cancelled", {
      completed_at: new Date().toISOString(),
      success: false,
      error: aborted ? "cancelled_by_user" : "cancel_signal_sent",
    })

    return {
      task_id: req.params.task_id,
      cancelled: true,
      was_running: task.status === "running",
    }
  })

  app.get("/workspace/info", async () => ({ root: activeWorkspaceRoot }))

  app.post<{ Body: { path: string } }>("/workspace/set-root", async (req, reply) => {
    const path = req.body?.path
    if (!path || typeof path !== "string") {
      return reply.code(400).send({ detail: "path is required" })
    }
    activeWorkspaceRoot = path
    return { root: activeWorkspaceRoot }
  })

  app.get("/config", async () => ({
    "model.default_backend": settings.model_default_backend,
    "provider.default_model": settings.provider_default_model,
  }))

  app.get("/config/providers", async () => {
    const response = await adapter.fetchConfigProviders(activeWorkspaceRoot)
    return response
  })

  app.post("/config", async (req, reply) => {
    const parsed = ConfigUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_config_update" })
    }

    if (parsed.data.key === "model.default_backend" && typeof parsed.data.value === "string") {
      settings.model_default_backend = parsed.data.value
    }
    if (parsed.data.key === "provider.default_model" && typeof parsed.data.value === "string") {
      settings.provider_default_model = parsed.data.value
    }

    return { ok: true, key: parsed.data.key, value: parsed.data.value }
  })

  app.get("/scheduler/jobs", async () => schedulerStore.list())

  app.post("/scheduler/jobs", async (req, reply) => {
    const parsed = SchedulerJobCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_scheduler_job", details: parsed.error.issues })
    }

    const body = parsed.data
    const jobId = body.job_id ?? randomUUID()
    const job = schedulerStore.create({
      job_id: jobId,
      description: body.description,
      schedule_type: body.schedule_type,
      interval_seconds: body.interval_seconds,
      cron: body.cron,
      enabled: body.enabled ?? true,
      timeout_s: body.timeout_s,
      max_failures: body.max_failures ?? 3,
      task_prompt: body.task_prompt,
      model_backend: body.model_backend,
      workflow_mode: body.workflow_mode,
    })
    return { ok: true, job_id: job.job_id }
  })

  app.delete<{ Params: { job_id: string } }>("/scheduler/jobs/:job_id", async (req) => {
    const deleted = schedulerStore.delete(req.params.job_id)
    return { ok: true, job_id: req.params.job_id, deleted }
  })

  app.post<{ Params: { job_id: string } }>("/scheduler/jobs/:job_id/enabled", async (req, reply) => {
    const parsed = SchedulerEnabledSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_enabled_state" })
    }

    const updated = schedulerStore.update(req.params.job_id, { enabled: parsed.data.enabled })
    if (!updated) {
      return reply.code(404).send({ ok: false, error: "job_not_found" })
    }

    return { job_id: updated.job_id, enabled: updated.enabled }
  })

  app.post<{ Params: { job_id: string } }>("/scheduler/jobs/:job_id/run", async (req, reply) => {
    const job = schedulerStore.get(req.params.job_id)
    if (!job) {
      return reply.code(404).send({ ok: false, error: "job_not_found" })
    }

    const run = await runScheduledJob(job)
    return { ok: true, job_id: job.job_id, task_id: run.task_id, run_id: run.run_id }
  })

  app.post("/scheduler/tick", async () => {
    const result: SchedulerTickResult = {
      ran_jobs: [],
      failed_jobs: [],
      timed_out_jobs: [],
      auto_disabled_jobs: [],
      job_count: schedulerStore.list().length,
    }

    for (const job of schedulerStore.list()) {
      if (!job.enabled) continue
      try {
        await runScheduledJob(job)
        result.ran_jobs.push(job.job_id)
      } catch {
        result.failed_jobs.push(job.job_id)
      }
    }

    return result
  })

  async function runScheduledJob(job: {
    job_id: string
    task_prompt: string
    model_backend?: string
    workflow_mode?: "lightning" | "superpowered"
  }) {
    const taskId = randomUUID()
    const runId = randomUUID()
    const now = new Date().toISOString()
    taskStore.upsert({
      task_id: taskId,
      run_id: runId,
      description: `Scheduler:${job.job_id}`,
      status: "running",
      created_at: now,
      started_at: now,
      output: { source: "scheduler", job_id: job.job_id },
      workspace_root: activeWorkspaceRoot,
    })

    const payload: ChatRequest = {
      prompt: job.task_prompt,
      model_backend: job.model_backend ?? settings.model_default_backend,
      workflow_mode: job.workflow_mode ?? "lightning",
    }

    const adapterResult = await adapter.runChat({
      taskId,
      runId,
      workspaceRoot: activeWorkspaceRoot,
      payload,
    })

    taskStore.updateStatus(taskId, "completed", {
      completed_at: new Date().toISOString(),
      success: adapterResult.success,
      error: adapterResult.error,
      output: {
        ...adapterResult,
        session_id: adapterResult.session_id,
        source: "scheduler",
        job_id: job.job_id,
      },
    })

    schedulerStore.update(job.job_id, {
      last_run_at: new Date().toISOString(),
      last_task_id: taskId,
    })

    return { task_id: taskId, run_id: runId }
  }

  return app
}

if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
  const app = buildServer()
  const port = Number(process.env.PORT ?? 8000)

  app
    .listen({ port, host: "0.0.0.0" })
    .then(() => {
      app.log.info({ port }, "TitanShift OpenCode bridge listening")
    })
    .catch((error) => {
      app.log.error(error)
      process.exit(1)
    })
}
