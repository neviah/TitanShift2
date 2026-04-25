import type { TaskRecord, TaskStatus } from "../types.js"

export class TaskStore {
  private tasks = new Map<string, TaskRecord>()

  upsert(task: TaskRecord): void {
    this.tasks.set(task.task_id, task)
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  updateStatus(taskId: string, status: TaskStatus, patch?: Partial<TaskRecord>): TaskRecord | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    const next: TaskRecord = {
      ...task,
      ...patch,
      status,
    }
    this.tasks.set(taskId, next)
    return next
  }
}
