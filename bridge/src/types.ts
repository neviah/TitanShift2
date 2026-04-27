export type WorkflowMode = "lightning" | "superpowered"

export type ChatHistoryMessage = {
  role: "user" | "assistant"
  content: string
}

export type ChatRequest = {
  prompt: string
  history?: ChatHistoryMessage[]
  model_backend?: string
  provider_model?: string
  workflow_mode?: WorkflowMode
  openrouter_api_key?: string
  spec_approved?: boolean
  plan_approved?: boolean
  plan_tasks?: Array<Record<string, unknown>>
  budget?: {
    max_steps?: number
    max_tokens?: number
    max_duration_ms?: number
  }
}

export type ChatResponse = {
  success: boolean
  response: string
  model: string
  mode: string
  workflow_mode?: string | null
  used_tools?: string[]
  created_paths?: string[]
  updated_paths?: string[]
  patch_summaries?: Array<Record<string, unknown>>
  error?: string | null
  task_id?: string
  run_id?: string
}

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export type TaskRecord = {
  task_id: string
  run_id: string
  description: string
  status: TaskStatus
  created_at: string
  started_at?: string
  completed_at?: string
  success?: boolean
  error?: string | null
  output: Record<string, unknown>
  workspace_root: string
}

export type SchedulerJob = {
  job_id: string
  description: string
  schedule_type: "interval" | "cron"
  interval_seconds?: number
  cron?: string
  enabled: boolean
  timeout_s?: number
  max_failures: number
  task_prompt: string
  model_backend?: string
  workflow_mode?: WorkflowMode
  last_run_at?: string
  last_task_id?: string
}

export type SchedulerTemplateJob = {
  job_id: string
  template_id: string
  description: string
  schedule_type: "interval" | "cron"
  interval_seconds?: number
  cron?: string
  enabled: boolean
  timeout_s?: number
  max_failures: number
}

export type SchedulerTaskStackJob = {
  job_id: string
  task_ids: string[]
  description: string
  schedule_type: "interval" | "cron"
  interval_seconds?: number
  cron?: string
  enabled: boolean
  timeout_s?: number
  max_failures: number
  model_backend?: string
  workflow_mode?: WorkflowMode
  budget?: {
    max_steps?: number
    max_tokens?: number
    max_duration_ms?: number
  }
}

export type SchedulerTickResult = {
  ran_jobs: string[]
  failed_jobs: string[]
  timed_out_jobs: string[]
  auto_disabled_jobs: string[]
  job_count: number
}

export type ConfigProvidersResponse = {
  providers: Array<{
    id: string
    name: string
  }>
  default: Record<string, string>
}

export type RuntimeSettings = {
  model_default_backend: string
  provider_openrouter_api_key: string
  provider_default_model: string
}
