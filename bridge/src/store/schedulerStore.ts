import type { SchedulerJob } from "../types.js"

export class SchedulerStore {
  private jobs = new Map<string, SchedulerJob>()

  replaceAll(jobs: SchedulerJob[]): void {
    this.jobs.clear()
    for (const job of jobs) {
      this.jobs.set(job.job_id, job)
    }
  }

  create(job: SchedulerJob): SchedulerJob {
    this.jobs.set(job.job_id, job)
    return job
  }

  list(): SchedulerJob[] {
    return [...this.jobs.values()].sort((a, b) => a.job_id.localeCompare(b.job_id))
  }

  get(jobId: string): SchedulerJob | undefined {
    return this.jobs.get(jobId)
  }

  update(jobId: string, patch: Partial<SchedulerJob>): SchedulerJob | undefined {
    const existing = this.jobs.get(jobId)
    if (!existing) return undefined
    const next = { ...existing, ...patch }
    this.jobs.set(jobId, next)
    return next
  }

  delete(jobId: string): boolean {
    return this.jobs.delete(jobId)
  }
}
