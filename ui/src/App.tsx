import { useEffect, useState } from "react"
import {
  cancelTask,
  createSchedulerJob,
  createSchedulerTaskStack,
  createSchedulerTemplateJob,
  fetchConfig,
  fetchSchedulerJobs,
  fetchSchedulerTaskStacks,
  fetchSchedulerTemplateJobs,
  fetchTasks,
  fetchWorkspaceInfo,
  sendChat,
  setWorkspaceRoot,
  updateConfig,
} from "./api/client"
import type { SchedulerJob, SchedulerTaskStackJob, SchedulerTemplateJob, TaskSummary } from "./api/types"

type Tab = "chat" | "tasks" | "workspaces" | "scheduler" | "settings"

export function App() {
  const [tab, setTab] = useState<Tab>("chat")
  const [prompt, setPrompt] = useState("")
  const [chatResult, setChatResult] = useState("")
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [workspaceRoot, setWorkspaceRootState] = useState("")
  const [schedulerJobs, setSchedulerJobs] = useState<SchedulerJob[]>([])
  const [templateJobs, setTemplateJobs] = useState<SchedulerTemplateJob[]>([])
  const [taskStacks, setTaskStacks] = useState<SchedulerTaskStackJob[]>([])
  const [modelBackend, setModelBackend] = useState("")

  useEffect(() => {
    void refreshAll()
  }, [])

  async function refreshAll() {
    const [taskRows, workspace, config, jobs, templates, stacks] = await Promise.all([
      fetchTasks(),
      fetchWorkspaceInfo(),
      fetchConfig(),
      fetchSchedulerJobs(),
      fetchSchedulerTemplateJobs(),
      fetchSchedulerTaskStacks(),
    ])

    setTasks(taskRows)
    setWorkspaceRootState(workspace.root)
    setModelBackend(String(config["model.default_backend"] ?? ""))
    setSchedulerJobs(jobs)
    setTemplateJobs(templates)
    setTaskStacks(stacks)
  }

  async function handleChat() {
    const result = await sendChat(prompt)
    setChatResult(result.response || result.error || "No response")
    await refreshAll()
  }

  return (
    <div style={{ fontFamily: "ui-sans-serif, Segoe UI, sans-serif", margin: 24 }}>
      <h1>TitanShift2 UI Shell</h1>
      <p>Bridge-driven shell for Chat, Tasks, Workspaces, Scheduler, and Settings.</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["chat", "tasks", "workspaces", "scheduler", "settings"] as Tab[]).map((item) => (
          <button key={item} onClick={() => setTab(item)} disabled={tab === item}>
            {item}
          </button>
        ))}
      </div>

      {tab === "chat" && (
        <section>
          <h2>Chat</h2>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            style={{ width: "100%", maxWidth: 720 }}
          />
          <div>
            <button onClick={handleChat}>Send</button>
          </div>
          <pre>{chatResult}</pre>
        </section>
      )}

      {tab === "tasks" && (
        <section>
          <h2>Tasks</h2>
          <button onClick={() => void refreshAll()}>Refresh</button>
          <ul>
            {tasks.map((task) => (
              <li key={task.task_id}>
                {task.task_id} - {task.status}
                <button onClick={() => void cancelTask(task.task_id).then(refreshAll)}>Cancel</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "workspaces" && (
        <section>
          <h2>Workspaces</h2>
          <input
            value={workspaceRoot}
            onChange={(e) => setWorkspaceRootState(e.target.value)}
            style={{ width: "100%", maxWidth: 720 }}
          />
          <div>
            <button onClick={() => void setWorkspaceRoot(workspaceRoot).then(refreshAll)}>Set Root</button>
          </div>
        </section>
      )}

      {tab === "scheduler" && (
        <section>
          <h2>Scheduler</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => void createSchedulerJob("Say hello from scheduler").then(refreshAll)}>+ Job</button>
            <button onClick={() => void createSchedulerTemplateJob("template-default").then(refreshAll)}>
              + Template Job
            </button>
            <button onClick={() => void createSchedulerTaskStack(tasks.slice(0, 2).map((t) => t.task_id)).then(refreshAll)}>
              + Task Stack
            </button>
          </div>
          <h3>Jobs</h3>
          <ul>{schedulerJobs.map((job) => <li key={job.job_id}>{job.job_id} - {job.description}</li>)}</ul>
          <h3>Template Jobs</h3>
          <ul>{templateJobs.map((job) => <li key={job.job_id}>{job.job_id} - {job.template_id}</li>)}</ul>
          <h3>Task Stacks</h3>
          <ul>{taskStacks.map((job) => <li key={job.job_id}>{job.job_id} - {job.task_ids.join(", ")}</li>)}</ul>
        </section>
      )}

      {tab === "settings" && (
        <section>
          <h2>Settings</h2>
          <label>model.default_backend</label>
          <input
            value={modelBackend}
            onChange={(e) => setModelBackend(e.target.value)}
            style={{ width: "100%", maxWidth: 720 }}
          />
          <div>
            <button onClick={() => void updateConfig("model.default_backend", modelBackend).then(refreshAll)}>
              Save
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
