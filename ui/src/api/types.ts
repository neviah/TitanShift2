export type ChatResponse = {
  success: boolean
  response: string
  model: string
  mode: string
  error?: string | null
  task_id?: string
  run_id?: string
}

export type StreamEvent = {
  type: string
  [key: string]: unknown
}

export type TaskSummary = {
  task_id: string
  run_id: string
  description: string
  status: string
  created_at: string
  completed_at?: string
  error?: string | null
}

export type SchedulerJob = {
  job_id: string
  description: string
  schedule_type: "interval" | "cron"
  enabled: boolean
  interval_seconds?: number
  cron?: string
}

export type SchedulerTemplateJob = {
  job_id: string
  template_id: string
  description: string
  schedule_type: "interval" | "cron"
  enabled: boolean
}

export type SchedulerTaskStackJob = {
  job_id: string
  task_ids: string[]
  description: string
  schedule_type: "interval" | "cron"
  enabled: boolean
}

export type ConfigProvidersResponse = {
  providers: Array<{ id: string; name: string }>
  default: Record<string, string>
}

export type SchedulerTickResponse = {
  ran_jobs: string[]
  failed_jobs: string[]
  timed_out_jobs: string[]
  auto_disabled_jobs: string[]
  job_count: number
}
