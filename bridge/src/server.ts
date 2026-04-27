import Fastify from "fastify"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { OpenCodeHttpAdapter } from "./adapters/opencodeAdapter.js"
import { TaskStore } from "./store/taskStore.js"
import { SchedulerStore } from "./store/schedulerStore.js"
import type {
  ChatRequest,
  RuntimeSettings,
  SchedulerJob,
  SchedulerTaskStackJob,
  SchedulerTemplateJob,
  SchedulerTickResult,
  TaskRecord,
} from "./types.js"

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

const SchedulerTemplateJobCreateSchema = z.object({
  template_id: z.string().min(1),
  job_id: z.string().optional(),
  description: z.string().optional(),
  schedule_type: z.enum(["interval", "cron"]),
  interval_seconds: z.number().int().positive().optional(),
  cron: z.string().optional(),
  enabled: z.boolean().optional(),
  timeout_s: z.number().positive().optional(),
  max_failures: z.number().int().nonnegative().optional(),
})

const SchedulerTaskStackCreateSchema = z.object({
  task_ids: z.array(z.string().min(1)).min(1),
  job_id: z.string().optional(),
  description: z.string().optional(),
  schedule_type: z.enum(["interval", "cron"]),
  interval_seconds: z.number().int().positive().optional(),
  cron: z.string().optional(),
  enabled: z.boolean().optional(),
  timeout_s: z.number().positive().optional(),
  max_failures: z.number().int().nonnegative().optional(),
  model_backend: z.string().optional(),
  workflow_mode: z.enum(["lightning", "superpowered"]).optional(),
  budget: z
    .object({
      max_steps: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
      max_duration_ms: z.number().int().positive().optional(),
    })
    .optional(),
})

export function buildServer() {
  const app = Fastify({ logger: true })
  const taskStore = new TaskStore()
  const schedulerStore = new SchedulerStore()
  const schedulerTemplateJobs = new Map<string, SchedulerTemplateJob>()
  const schedulerTaskStacks = new Map<string, SchedulerTaskStackJob>()
  const schedulerStateFile = resolveSchedulerStateFile()

  let activeWorkspaceRoot = process.cwd()
  let settings: RuntimeSettings = {
    model_default_backend: "opencode/default",
    provider_default_model: "opencode/default",
  }

  hydrateSchedulerState()

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
    const executed = await executeChatTask(payload)
    if (!executed.ok) {
      return reply.code(500).send({
        success: false,
        response: "",
        model: "unknown",
        mode: "error",
        task_id: executed.taskId,
        run_id: executed.runId,
        error: executed.error,
      })
    }

    return {
      ...executed.result,
      task_id: executed.taskId,
      run_id: executed.runId,
    }
  })

  app.post("/runs", async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_request", details: parsed.error.issues })
    }

    const payload: ChatRequest = {
      ...parsed.data,
      model_backend: parsed.data.model_backend ?? settings.model_default_backend,
    }

    const executed = await executeChatTask(payload)
    return {
      ok: executed.ok,
      run_id: executed.runId,
      task_id: executed.taskId,
      status: executed.ok ? "completed" : "failed",
      error: executed.ok ? null : executed.error,
    }
  })

  app.get("/runs", async () => {
    return taskStore.list().map((task) => ({
      run_id: task.run_id,
      task_id: task.task_id,
      description: task.description,
      status: task.status,
      created_at: task.created_at,
      completed_at: task.completed_at ?? null,
      success: task.success ?? null,
      error: task.error ?? null,
    }))
  })

  app.get<{ Params: { run_id: string } }>("/runs/:run_id", async (req, reply) => {
    const task = taskStore.getByRunId(req.params.run_id)
    if (!task) {
      return reply.code(404).send({ detail: "Run not found" })
    }
    return {
      run_id: task.run_id,
      task_id: task.task_id,
      status: task.status,
      output: task.output,
      error: task.error ?? null,
      success: task.success ?? null,
    }
  })

  app.post("/chat/stream", async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: "invalid_request", details: parsed.error.issues })
    }

    const payload: ChatRequest = {
      ...parsed.data,
      model_backend: parsed.data.model_backend ?? settings.model_default_backend,
    }

    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")

    const streamEvent = (event: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    const taskId = randomUUID()
    const runId = randomUUID()
    const now = new Date().toISOString()
    taskStore.upsert({
      task_id: taskId,
      run_id: runId,
      description: payload.prompt,
      status: "running",
      created_at: now,
      started_at: now,
      output: {},
      workspace_root: activeWorkspaceRoot,
    })

    streamEvent({ type: "start", task_id: taskId, run_id: runId, workflow_mode: payload.workflow_mode ?? "lightning" })

    try {
      const result = await withTimeout(
        adapter.runChat({
          taskId,
          runId,
          workspaceRoot: activeWorkspaceRoot,
          payload,
        }),
        payload.budget?.max_duration_ms,
      )

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

      if (result.response) {
        streamEvent({ type: "text_delta", text: result.response })
      }

      streamEvent({
        type: "done",
        success: result.success,
        response: result.response,
        model: result.model,
        mode: result.mode,
        workflow_mode: result.workflow_mode,
        used_tools: result.used_tools ?? [],
        created_paths: result.created_paths ?? [],
        updated_paths: result.updated_paths ?? [],
        patch_summaries: result.patch_summaries ?? [],
        task_id: taskId,
        run_id: runId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error"
      taskStore.updateStatus(taskId, "failed", {
        completed_at: new Date().toISOString(),
        success: false,
        error: message,
        output: { error: message },
      })

      streamEvent({ type: "error", error: message, task_id: taskId, run_id: runId })
    } finally {
      streamEvent({ type: "eof", task_id: taskId, run_id: runId })
      reply.raw.end()
    }

    return reply
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

    persistSchedulerState()

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
    persistSchedulerState()
    return { ok: true, job_id: job.job_id }
  })

  app.delete<{ Params: { job_id: string } }>("/scheduler/jobs/:job_id", async (req) => {
    const deleted = schedulerStore.delete(req.params.job_id)
    if (deleted) persistSchedulerState()
    return { ok: true, job_id: req.params.job_id, deleted }
  })

  app.get("/scheduler/template-jobs", async () => {
    return [...schedulerTemplateJobs.values()].sort((a, b) => a.job_id.localeCompare(b.job_id))
  })

  app.post("/scheduler/template-jobs", async (req, reply) => {
    const parsed = SchedulerTemplateJobCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_template_job", details: parsed.error.issues })
    }

    const body = parsed.data
    const jobId = body.job_id ?? randomUUID()
    schedulerTemplateJobs.set(jobId, {
      job_id: jobId,
      template_id: body.template_id,
      description: body.description ?? `Template ${body.template_id}`,
      schedule_type: body.schedule_type,
      interval_seconds: body.interval_seconds,
      cron: body.cron,
      enabled: body.enabled ?? true,
      timeout_s: body.timeout_s,
      max_failures: body.max_failures ?? 3,
    })
    persistSchedulerState()

    return { ok: true, job_id: jobId, template_id: body.template_id }
  })

  app.delete<{ Params: { job_id: string } }>("/scheduler/template-jobs/:job_id", async (req) => {
    const deleted = schedulerTemplateJobs.delete(req.params.job_id)
    if (deleted) persistSchedulerState()
    return { ok: true, job_id: req.params.job_id, deleted }
  })

  app.post<{ Params: { job_id: string } }>("/scheduler/template-jobs/:job_id/enabled", async (req, reply) => {
    const parsed = SchedulerEnabledSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_enabled_state" })
    }

    const row = schedulerTemplateJobs.get(req.params.job_id)
    if (!row) {
      return reply.code(404).send({ ok: false, error: "job_not_found" })
    }

    const next = { ...row, enabled: parsed.data.enabled }
    schedulerTemplateJobs.set(req.params.job_id, next)
    persistSchedulerState()
    return { job_id: next.job_id, enabled: next.enabled }
  })

  app.post<{ Params: { job_id: string } }>("/scheduler/template-jobs/:job_id/run", async (req, reply) => {
    const job = schedulerTemplateJobs.get(req.params.job_id)
    if (!job) {
      return reply.code(404).send({ ok: false, error: "job_not_found" })
    }

    const run = await runScheduledTemplateJob(job)
    return { ok: true, job_id: job.job_id, task_id: run.task_id, run_id: run.run_id }
  })

  app.get("/scheduler/task-stacks", async () => {
    return [...schedulerTaskStacks.values()].sort((a, b) => a.job_id.localeCompare(b.job_id))
  })

  app.post("/scheduler/task-stacks", async (req, reply) => {
    const parsed = SchedulerTaskStackCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_task_stack", details: parsed.error.issues })
    }

    const body = parsed.data
    const jobId = body.job_id ?? randomUUID()
    schedulerTaskStacks.set(jobId, {
      job_id: jobId,
      task_ids: body.task_ids,
      description: body.description ?? `Task stack ${body.task_ids.length} tasks`,
      schedule_type: body.schedule_type,
      interval_seconds: body.interval_seconds,
      cron: body.cron,
      enabled: body.enabled ?? true,
      timeout_s: body.timeout_s,
      max_failures: body.max_failures ?? 3,
      model_backend: body.model_backend,
      workflow_mode: body.workflow_mode,
      budget: body.budget,
    })
    persistSchedulerState()

    return { ok: true, job_id: jobId, task_count: body.task_ids.length }
  })

  app.delete<{ Params: { job_id: string } }>("/scheduler/task-stacks/:job_id", async (req) => {
    const deleted = schedulerTaskStacks.delete(req.params.job_id)
    if (deleted) persistSchedulerState()
    return { ok: true, job_id: req.params.job_id, deleted }
  })

  app.post<{ Params: { job_id: string } }>("/scheduler/task-stacks/:job_id/enabled", async (req, reply) => {
    const parsed = SchedulerEnabledSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_enabled_state" })
    }

    const row = schedulerTaskStacks.get(req.params.job_id)
    if (!row) {
      return reply.code(404).send({ ok: false, error: "job_not_found" })
    }

    const next = { ...row, enabled: parsed.data.enabled }
    schedulerTaskStacks.set(req.params.job_id, next)
    persistSchedulerState()
    return { job_id: next.job_id, enabled: next.enabled }
  })

  app.post<{ Params: { job_id: string } }>("/scheduler/task-stacks/:job_id/run", async (req, reply) => {
    const job = schedulerTaskStacks.get(req.params.job_id)
    if (!job) {
      return reply.code(404).send({ ok: false, error: "job_not_found" })
    }

    const run = await runScheduledTaskStack(job)
    return { ok: true, job_id: job.job_id, task_id: run.task_id, run_id: run.run_id }
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

    persistSchedulerState()
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
      job_count: schedulerStore.list().length + schedulerTemplateJobs.size + schedulerTaskStacks.size,
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

    for (const job of schedulerTemplateJobs.values()) {
      if (!job.enabled) continue
      try {
        await runScheduledTemplateJob(job)
        result.ran_jobs.push(job.job_id)
      } catch {
        result.failed_jobs.push(job.job_id)
      }
    }

    for (const job of schedulerTaskStacks.values()) {
      if (!job.enabled) continue
      try {
        await runScheduledTaskStack(job)
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
    timeout_s?: number
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

    const adapterResult = await withTimeout(
      adapter.runChat({
        taskId,
        runId,
        workspaceRoot: activeWorkspaceRoot,
        payload,
      }),
      jobTimeoutMs(job),
    )

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
    persistSchedulerState()

    return { task_id: taskId, run_id: runId }
  }

  function resolveSchedulerStateFile(): string | null {
    if (process.env.SCHEDULER_STATE_FILE) {
      return process.env.SCHEDULER_STATE_FILE
    }

    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
      return null
    }

    return join(process.cwd(), ".titanshift", "scheduler-state.json")
  }

  function hydrateSchedulerState() {
    if (!schedulerStateFile || !existsSync(schedulerStateFile)) return

    try {
      const raw = readFileSync(schedulerStateFile, "utf-8")
      const parsed = JSON.parse(raw) as {
        settings?: RuntimeSettings
        jobs?: SchedulerJob[]
        template_jobs?: SchedulerTemplateJob[]
        task_stacks?: SchedulerTaskStackJob[]
      }

      if (parsed.settings) {
        if (typeof parsed.settings.model_default_backend === "string") {
          settings.model_default_backend = parsed.settings.model_default_backend
        }
        if (typeof parsed.settings.provider_default_model === "string") {
          settings.provider_default_model = parsed.settings.provider_default_model
        }
      }

      schedulerStore.replaceAll(Array.isArray(parsed.jobs) ? parsed.jobs : [])
      schedulerTemplateJobs.clear()
      schedulerTaskStacks.clear()

      for (const job of Array.isArray(parsed.template_jobs) ? parsed.template_jobs : []) {
        schedulerTemplateJobs.set(job.job_id, job)
      }
      for (const job of Array.isArray(parsed.task_stacks) ? parsed.task_stacks : []) {
        schedulerTaskStacks.set(job.job_id, job)
      }
    } catch (error) {
      app.log.warn({ error }, "failed_to_hydrate_scheduler_state")
    }
  }

  function persistSchedulerState() {
    if (!schedulerStateFile) return

    try {
      mkdirSync(dirname(schedulerStateFile), { recursive: true })
      writeFileSync(
        schedulerStateFile,
        JSON.stringify(
          {
            settings,
            jobs: schedulerStore.list(),
            template_jobs: [...schedulerTemplateJobs.values()].sort((a, b) => a.job_id.localeCompare(b.job_id)),
            task_stacks: [...schedulerTaskStacks.values()].sort((a, b) => a.job_id.localeCompare(b.job_id)),
          },
          null,
          2,
        ),
        "utf-8",
      )
    } catch (error) {
      app.log.warn({ error }, "failed_to_persist_scheduler_state")
    }
  }

  async function executeChatTask(payload: ChatRequest) {
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
      const result = await withTimeout(
        adapter.runChat({
          taskId,
          runId,
          workspaceRoot: activeWorkspaceRoot,
          payload,
        }),
        payload.budget?.max_duration_ms,
      )

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

      return { ok: true as const, result, taskId, runId }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error"
      taskStore.updateStatus(taskId, "failed", {
        completed_at: new Date().toISOString(),
        success: false,
        error: message,
        output: { error: message },
      })
      return { ok: false as const, error: message, taskId, runId }
    }
  }

  function jobTimeoutMs(job: { timeout_s?: number }): number | undefined {
    if (typeof job.timeout_s !== "number") return undefined
    if (!Number.isFinite(job.timeout_s) || job.timeout_s <= 0) return undefined
    return Math.floor(job.timeout_s * 1000)
  }

  async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise

    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout_exceeded")), timeoutMs)
    })

    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function runScheduledTemplateJob(job: SchedulerTemplateJob) {
    return runScheduledJob({
      job_id: job.job_id,
      task_prompt: `Run template ${job.template_id}`,
      workflow_mode: "lightning",
      timeout_s: job.timeout_s,
    })
  }

  async function runScheduledTaskStack(job: SchedulerTaskStackJob) {
    const prompt = `Run task stack: ${job.task_ids.join(", ")}`
    return runScheduledJob({
      job_id: job.job_id,
      task_prompt: prompt,
      model_backend: job.model_backend,
      workflow_mode: job.workflow_mode,
      timeout_s: job.timeout_s,
    })
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
