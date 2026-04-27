import type {
  ChatResponse,
  ConfigProvidersResponse,
  RunDetail,
  RunSummary,
  SchedulerJob,
  SchedulerTaskStackJob,
  SchedulerTickResponse,
  SchedulerTemplateJob,
  StreamEvent,
  TaskSummary,
} from "./types"

const API_BASE = "/api"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `Request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
}

export function sendChat(prompt: string): Promise<ChatResponse> {
  return request("/chat", { method: "POST", body: JSON.stringify({ prompt }) })
}

export function streamChat(
  prompt: string,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  return fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  }).then(async (response) => {
    if (!response.ok || !response.body) {
      throw new Error("Stream failed")
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((x) => x.startsWith("data: "))
        if (!line) continue
        const payload = JSON.parse(line.slice(6)) as StreamEvent
        onEvent(payload)
      }
    }
  })
}

export function fetchTasks(): Promise<TaskSummary[]> {
  return request("/tasks")
}

export function fetchRuns(): Promise<RunSummary[]> {
  return request("/runs")
}

export function fetchRun(runId: string): Promise<RunDetail> {
  return request(`/runs/${encodeURIComponent(runId)}`)
}

export function cancelTask(taskId: string): Promise<{ cancelled: boolean }> {
  return request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: JSON.stringify({}) })
}

export function fetchWorkspaceInfo(): Promise<{ root: string }> {
  return request("/workspace/info")
}

export function setWorkspaceRoot(path: string): Promise<{ root: string }> {
  return request("/workspace/set-root", { method: "POST", body: JSON.stringify({ path }) })
}

export function fetchConfig(): Promise<Record<string, unknown>> {
  return request("/config")
}

export function fetchConfigProviders(): Promise<ConfigProvidersResponse> {
  return request("/config/providers")
}

export function updateConfig(key: string, value: unknown): Promise<{ ok: boolean }> {
  return request("/config", { method: "POST", body: JSON.stringify({ key, value }) })
}

export function fetchSchedulerJobs(): Promise<SchedulerJob[]> {
  return request("/scheduler/jobs")
}

export function createSchedulerJob(prompt: string): Promise<{ job_id: string }> {
  return request("/scheduler/jobs", {
    method: "POST",
    body: JSON.stringify({
      description: "UI created job",
      schedule_type: "interval",
      interval_seconds: 60,
      task_prompt: prompt,
    }),
  })
}

export function deleteSchedulerJob(jobId: string): Promise<{ deleted: boolean }> {
  return request(`/scheduler/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" })
}

export function setSchedulerJobEnabled(jobId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return request(`/scheduler/jobs/${encodeURIComponent(jobId)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  })
}

export function fetchSchedulerTemplateJobs(): Promise<SchedulerTemplateJob[]> {
  return request("/scheduler/template-jobs")
}

export function createSchedulerTemplateJob(templateId: string): Promise<{ job_id: string }> {
  return request("/scheduler/template-jobs", {
    method: "POST",
    body: JSON.stringify({
      template_id: templateId,
      schedule_type: "interval",
      interval_seconds: 60,
    }),
  })
}

export function deleteSchedulerTemplateJob(jobId: string): Promise<{ deleted: boolean }> {
  return request(`/scheduler/template-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" })
}

export function setSchedulerTemplateJobEnabled(jobId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return request(`/scheduler/template-jobs/${encodeURIComponent(jobId)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  })
}

export function fetchSchedulerTaskStacks(): Promise<SchedulerTaskStackJob[]> {
  return request("/scheduler/task-stacks")
}

export function createSchedulerTaskStack(taskIds: string[]): Promise<{ job_id: string }> {
  return request("/scheduler/task-stacks", {
    method: "POST",
    body: JSON.stringify({
      task_ids: taskIds,
      schedule_type: "interval",
      interval_seconds: 60,
    }),
  })
}

export function deleteSchedulerTaskStack(jobId: string): Promise<{ deleted: boolean }> {
  return request(`/scheduler/task-stacks/${encodeURIComponent(jobId)}`, { method: "DELETE" })
}

export function setSchedulerTaskStackEnabled(jobId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return request(`/scheduler/task-stacks/${encodeURIComponent(jobId)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  })
}

export function triggerSchedulerTick(): Promise<SchedulerTickResponse> {
  return request("/scheduler/tick", { method: "POST", body: JSON.stringify({}) })
}
