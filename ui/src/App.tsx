import { useEffect, useState } from "react"
import {
  cancelTask,
  createSchedulerJob,
  createSchedulerTaskStack,
  createSchedulerTemplateJob,
  deleteSchedulerJob,
  deleteSchedulerTaskStack,
  deleteSchedulerTemplateJob,
  fetchConfig,
  fetchConfigProviders,
  fetchRun,
  fetchRuns,
  fetchSchedulerJobs,
  fetchSchedulerTaskStacks,
  fetchSchedulerTemplateJobs,
  fetchTasks,
  fetchWorkspaceInfo,
  sendChat,
  setSchedulerJobEnabled,
  setSchedulerTaskStackEnabled,
  setSchedulerTemplateJobEnabled,
  setWorkspaceRoot,
  streamChat,
  triggerSchedulerTick,
  updateConfig,
} from "./api/client"
import type {
  RunDetail,
  RunSummary,
  SchedulerJob,
  SchedulerTaskStackJob,
  SchedulerTemplateJob,
  StreamEvent,
  TaskSummary,
} from "./api/types"
import "./App.css"

type Tab = "chat" | "tasks" | "workspaces" | "scheduler" | "settings"

export function App() {
  const [tab, setTab] = useState<Tab>("chat")
  const [prompt, setPrompt] = useState("")
  const [chatResult, setChatResult] = useState("")
  const [chatStreamLog, setChatStreamLog] = useState<string[]>([])
  const [chatStreamText, setChatStreamText] = useState("")
  const [activeRunId, setActiveRunId] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null)
  const [workspaceRoot, setWorkspaceRootState] = useState("")
  const [schedulerJobs, setSchedulerJobs] = useState<SchedulerJob[]>([])
  const [templateJobs, setTemplateJobs] = useState<SchedulerTemplateJob[]>([])
  const [taskStacks, setTaskStacks] = useState<SchedulerTaskStackJob[]>([])
  const [modelBackend, setModelBackend] = useState("")
  const [providerDefaultModel, setProviderDefaultModel] = useState("")
  const [providerOptions, setProviderOptions] = useState<Array<{ id: string; name: string }>>([])
  const [selectedProvider, setSelectedProvider] = useState("")
  const [schedulerPrompt, setSchedulerPrompt] = useState("Say hello from scheduler")
  const [templateId, setTemplateId] = useState("template-default")
  const [taskStackInput, setTaskStackInput] = useState("task-1,task-2")
  const [tickSummary, setTickSummary] = useState("")

  useEffect(() => {
    void refreshAll()
  }, [])

  async function refreshAll() {
    const [taskRows, runRows, workspace, config, providers, jobs, templates, stacks] = await Promise.all([
      fetchTasks(),
      fetchRuns(),
      fetchWorkspaceInfo(),
      fetchConfig(),
      fetchConfigProviders().catch(() => ({ providers: [], default: {} })),
      fetchSchedulerJobs(),
      fetchSchedulerTemplateJobs(),
      fetchSchedulerTaskStacks(),
    ])

    setTasks(taskRows)
    setRuns(runRows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)))
    setWorkspaceRootState(workspace.root)
    setModelBackend(String(config["model.default_backend"] ?? ""))
    setProviderDefaultModel(String(config["provider.default_model"] ?? ""))
    setProviderOptions(providers.providers)
    if (providers.providers.length > 0 && !selectedProvider) {
      setSelectedProvider(providers.providers[0].id)
    }
    setSchedulerJobs(jobs)
    setTemplateJobs(templates)
    setTaskStacks(stacks)
  }

  async function handleChat() {
    const result = await sendChat(prompt)
    setChatResult(result.response || result.error || "No response")
    if (result.run_id) {
      setActiveRunId(result.run_id)
      const detail = await fetchRun(result.run_id)
      setSelectedRun(detail)
    }
    await refreshAll()
  }

  async function handleStreamChat() {
    setStreaming(true)
    setChatStreamLog([])
    setChatStreamText("")
    let streamedRunId = ""
    try {
      await streamChat(prompt, (event: StreamEvent) => {
        if (event.type === "start" && typeof event.run_id === "string") {
          streamedRunId = event.run_id
          setActiveRunId(event.run_id)
        }
        if (event.type === "text_delta" && typeof event.delta === "string") {
          setChatStreamText((prev) => prev + event.delta)
        }
        setChatStreamLog((prev) => [...prev, JSON.stringify(event)])
      })
      await refreshAll()
      if (streamedRunId) {
        const detail = await fetchRun(streamedRunId)
        setSelectedRun(detail)
      }
    } catch (error) {
      setChatStreamLog((prev) => [...prev, `stream_error:${String(error)}`])
    } finally {
      setStreaming(false)
    }
  }

  async function inspectRun(runId: string) {
    const detail = await fetchRun(runId)
    setActiveRunId(runId)
    setSelectedRun(detail)
  }

  async function handleTick() {
    const tick = await triggerSchedulerTick()
    setTickSummary(`ran=${tick.ran_jobs.length}, failed=${tick.failed_jobs.length}, total=${tick.job_count}`)
    await refreshAll()
  }

  async function saveProviderModel() {
    await updateConfig("provider.default_model", providerDefaultModel)
    await refreshAll()
  }

  async function applyProviderDefault() {
    if (!selectedProvider) return
    const composed = `${selectedProvider}/${providerDefaultModel || "default"}`
    setProviderDefaultModel(composed)
    await updateConfig("provider.default_model", composed)
    await refreshAll()
  }

  return (
    <div className="app-shell">
      <div className="layout">
        <aside className="sidebar">
          <div className="logo">TitanShift2</div>
          <p className="muted">Workflow-preserving UI shell</p>
          {(["chat", "tasks", "workspaces", "scheduler", "settings"] as Tab[]).map((item) => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={`nav-button ${tab === item ? "active" : ""}`}
            >
              {item}
            </button>
          ))}
        </aside>

        <main className="panel">
          {tab === "chat" && (
            <section>
              <h2>Chat</h2>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                style={{ width: "100%", maxWidth: 860 }}
              />
              <div className="row">
                <button className="primary" onClick={() => void handleChat()}>
                  Send Sync
                </button>
                <button onClick={() => void handleStreamChat()} disabled={streaming}>
                  {streaming ? "Streaming..." : "Send Stream"}
                </button>
              </div>
              <h3>Sync reply</h3>
              <div className="chat-log">{chatResult || "No reply yet."}</div>
              <h3>Stream text</h3>
              <div className="chat-log">{chatStreamText || "No streamed text yet."}</div>
              <h3>Stream events</h3>
              <div className="chat-log">{chatStreamLog.join("\n") || "No stream events yet."}</div>
              <h3>Active run</h3>
              <div className="item">
                <div><strong>run_id:</strong> {activeRunId || "none"}</div>
                {selectedRun ? (
                  <div>
                    <div><strong>status:</strong> {selectedRun.status}</div>
                    <div><strong>task_id:</strong> {selectedRun.task_id}</div>
                    <div><strong>success:</strong> {String(selectedRun.success)}</div>
                  </div>
                ) : (
                  <div className="muted">No run selected.</div>
                )}
              </div>
            </section>
          )}

          {tab === "tasks" && (
            <section>
              <h2>Tasks</h2>
              <div className="row">
                <button onClick={() => void refreshAll()}>Refresh</button>
              </div>
              <div className="list">
                {tasks.map((task) => (
                  <div key={task.task_id} className="item">
                    <div><strong>{task.task_id}</strong></div>
                    <div className="muted">{task.description}</div>
                    <div className="muted">run_id: {task.run_id}</div>
                    <div>Status: {task.status}</div>
                    <div className="row">
                      <button className="warn" onClick={() => void cancelTask(task.task_id).then(refreshAll)}>
                        Cancel
                      </button>
                      <button onClick={() => void inspectRun(task.run_id)}>Inspect Run</button>
                    </div>
                  </div>
                ))}
              </div>

              <h3 style={{ marginTop: 14 }}>Recent runs</h3>
              <div className="list">
                {runs.slice(0, 10).map((run) => (
                  <div key={run.run_id} className="item">
                    <div><strong>{run.run_id}</strong></div>
                    <div className="muted">task: {run.task_id}</div>
                    <div>Status: {run.status}</div>
                    <div className="row">
                      <button onClick={() => void inspectRun(run.run_id)}>Inspect</button>
                    </div>
                  </div>
                ))}
              </div>

              {selectedRun && (
                <div style={{ marginTop: 14 }}>
                  <h3>Run detail</h3>
                  <div className="chat-log">{JSON.stringify(selectedRun.output, null, 2)}</div>
                </div>
              )}
            </section>
          )}

          {tab === "workspaces" && (
            <section>
              <h2>Workspaces</h2>
              <p className="muted">Set the active execution root used by bridge calls.</p>
              <input value={workspaceRoot} onChange={(e) => setWorkspaceRootState(e.target.value)} style={{ width: "100%" }} />
              <div className="row">
                <button className="primary" onClick={() => void setWorkspaceRoot(workspaceRoot).then(refreshAll)}>
                  Apply Root
                </button>
              </div>
            </section>
          )}

          {tab === "scheduler" && (
            <section>
              <h2>Scheduler</h2>
              <div className="row">
                <input value={schedulerPrompt} onChange={(e) => setSchedulerPrompt(e.target.value)} style={{ minWidth: 280 }} />
                <button className="primary" onClick={() => void createSchedulerJob(schedulerPrompt).then(refreshAll)}>
                  + Job
                </button>
                <input value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ minWidth: 180 }} />
                <button onClick={() => void createSchedulerTemplateJob(templateId).then(refreshAll)}>
                  + Template Job
                </button>
                <input value={taskStackInput} onChange={(e) => setTaskStackInput(e.target.value)} style={{ minWidth: 180 }} />
                <button
                  onClick={() =>
                    void createSchedulerTaskStack(
                      taskStackInput
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    ).then(refreshAll)
                  }
                >
                  + Task Stack
                </button>
                <button className="warn" onClick={() => void handleTick()}>
                  Tick Now
                </button>
              </div>
              <p className="muted">{tickSummary}</p>

              <h3>Latest run activity</h3>
              <div className="list">
                {runs.slice(0, 5).map((run) => (
                  <div key={`sched-${run.run_id}`} className="item">
                    <div><strong>{run.run_id}</strong></div>
                    <div className="muted">task: {run.task_id}</div>
                    <div>Status: {run.status}</div>
                    <div className="row">
                      <button onClick={() => void inspectRun(run.run_id)}>Inspect</button>
                    </div>
                  </div>
                ))}
              </div>

              <h3>Jobs</h3>
              <div className="list">
                {schedulerJobs.map((job) => (
                  <div key={job.job_id} className="item">
                    <div><strong>{job.job_id}</strong> - {job.description}</div>
                    <div className="row">
                      <button onClick={() => void setSchedulerJobEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                        {job.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="warn" onClick={() => void deleteSchedulerJob(job.job_id).then(refreshAll)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <h3>Template Jobs</h3>
              <div className="list">
                {templateJobs.map((job) => (
                  <div key={job.job_id} className="item">
                    <div><strong>{job.job_id}</strong> - {job.template_id}</div>
                    <div className="row">
                      <button onClick={() => void setSchedulerTemplateJobEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                        {job.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="warn" onClick={() => void deleteSchedulerTemplateJob(job.job_id).then(refreshAll)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <h3>Task Stacks</h3>
              <div className="list">
                {taskStacks.map((job) => (
                  <div key={job.job_id} className="item">
                    <div><strong>{job.job_id}</strong> - {job.task_ids.join(", ")}</div>
                    <div className="row">
                      <button onClick={() => void setSchedulerTaskStackEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                        {job.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="warn" onClick={() => void deleteSchedulerTaskStack(job.job_id).then(refreshAll)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {tab === "settings" && (
            <section>
              <h2>Settings</h2>
              <div className="row">
                <label className="muted">model.default_backend</label>
                <input value={modelBackend} onChange={(e) => setModelBackend(e.target.value)} style={{ minWidth: 420 }} />
                <button className="primary" onClick={() => void updateConfig("model.default_backend", modelBackend).then(refreshAll)}>
                  Save model backend
                </button>
              </div>
              <div className="row">
                <label className="muted">provider</label>
                <select value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)}>
                  <option value="">Select provider</option>
                  {providerOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} ({provider.id})
                    </option>
                  ))}
                </select>
                <input
                  value={providerDefaultModel}
                  onChange={(e) => setProviderDefaultModel(e.target.value)}
                  style={{ minWidth: 320 }}
                />
                <button onClick={() => void saveProviderModel()}>Save provider.default_model</button>
                <button onClick={() => void applyProviderDefault()}>Apply provider + model</button>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
