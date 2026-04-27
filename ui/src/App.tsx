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
  runSchedulerJob,
  runSchedulerTaskStack,
  runSchedulerTemplateJob,
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
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({})
  const [selectedProvider, setSelectedProvider] = useState("")
  const [schedulerPrompt, setSchedulerPrompt] = useState("Say hello from scheduler")
  const [templateId, setTemplateId] = useState("template-default")
  const [taskStackInput, setTaskStackInput] = useState("task-1,task-2")
  const [tickSummary, setTickSummary] = useState("")
  const schedulerRuns = runs.filter((run) => run.description.startsWith("Scheduler:"))
  const latestSchedulerFailure = schedulerRuns.find((run) => run.status === "failed")

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
    setProviderDefaults(providers.default)
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

  async function runAndInspect(runTrigger: Promise<{ run_id: string; task_id: string }>) {
    const started = await runTrigger
    await refreshAll()
    await inspectRun(started.run_id)
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
    const providerDefault = providerDefaults[selectedProvider]
    if (!providerDefault) return
    setProviderDefaultModel(providerDefault)
    await updateConfig("provider.default_model", providerDefault)
    await refreshAll()
  }

  function statusClass(status: string) {
    if (status === "completed") return "status-completed"
    if (status === "failed") return "status-failed"
    if (status === "running") return "status-running"
    if (status === "cancelled") return "status-cancelled"
    return "status-queued"
  }

  function formatTimestamp(value: string | null) {
    if (!value) return "-"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString()
  }

  const providerDefaultEntries = Object.entries(providerDefaults)

  return (
    <div className="app-shell">
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-topline">TitanShift Command Surface</div>
          <div className="logo">TitanShift2</div>
          <p className="muted">Red control-panel rebuild over OpenCode bridge</p>
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
          <div className="panel-header">
            <div>
              <div className="panel-kicker">TitanShift Control Panel</div>
              <h1>{tab.charAt(0).toUpperCase() + tab.slice(1)}</h1>
            </div>
            <div className="panel-status">
              <span className="badge status-running">workspace</span>
              <span className="muted panel-status-text">{workspaceRoot || "No workspace selected"}</span>
            </div>
          </div>

          {tab === "chat" && (
            <section className="section-grid two-up">
              <div className="control-card control-card-wide">
                <h2>Chat Dispatch</h2>
                <p className="muted section-copy">Run the active TitanShift prompt against the bridge or streaming path.</p>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="control-input prompt-area"
              />
              <div className="row">
                <button className="primary" onClick={() => void handleChat()}>
                  Send Sync
                </button>
                <button onClick={() => void handleStreamChat()} disabled={streaming}>
                  {streaming ? "Streaming..." : "Send Stream"}
                </button>
              </div>
              </div>

              <div className="control-card">
                <h3>Active run</h3>
                <div className="metric-line"><strong>run_id:</strong> {activeRunId || "none"}</div>
                {selectedRun ? (
                  <div className="stack">
                    <div className="metric-line"><strong>status:</strong> {selectedRun.status}</div>
                    <div className="metric-line"><strong>task_id:</strong> {selectedRun.task_id}</div>
                    <div className="metric-line"><strong>success:</strong> {String(selectedRun.success)}</div>
                  </div>
                ) : (
                  <div className="muted">No run selected.</div>
                )}
              </div>

              <div className="control-card">
              <h3>Sync reply</h3>
              <div className="chat-log">{chatResult || "No reply yet."}</div>
              </div>

              <div className="control-card">
              <h3>Stream text</h3>
              <div className="chat-log">{chatStreamText || "No streamed text yet."}</div>
              </div>

              <div className="control-card control-card-wide">
              <h3>Stream events</h3>
              <div className="chat-log">{chatStreamLog.join("\n") || "No stream events yet."}</div>
              </div>
            </section>
          )}

          {tab === "tasks" && (
            <section>
              <div className="section-grid">
                <div className="control-card control-card-wide">
                  <h2>Task Queue</h2>
                  <p className="muted section-copy">Inspect current tasks and jump directly into run detail output.</p>
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
                </div>

                <div className="control-card control-card-wide">
              <h3 style={{ marginTop: 14 }}>Recent runs</h3>
              <div className="list">
                {runs.slice(0, 10).map((run) => (
                  <div key={run.run_id} className="item">
                    <div><strong>{run.run_id}</strong></div>
                    <div className="muted">task: {run.task_id}</div>
                    <div className="muted">{run.description}</div>
                    <div className={`badge ${statusClass(run.status)}`}>{run.status}</div>
                    {run.error && <div className="badge status-failed">error: {run.error}</div>}
                    <div className="row">
                      <button onClick={() => void inspectRun(run.run_id)}>Inspect</button>
                    </div>
                  </div>
                ))}
              </div>
                </div>

              {selectedRun && (
                <div className="control-card control-card-wide">
                  <h3>Run detail</h3>
                  <div className="chat-log">{JSON.stringify(selectedRun.output, null, 2)}</div>
                </div>
              )}
              </div>
            </section>
          )}

          {tab === "workspaces" && (
            <section className="section-grid">
              <div className="control-card control-card-wide">
              <h2>Workspace Targeting</h2>
              <p className="muted">Set the active execution root used by bridge calls.</p>
              <input value={workspaceRoot} onChange={(e) => setWorkspaceRootState(e.target.value)} className="control-input control-input-wide" />
              <div className="row">
                <button className="primary" onClick={() => void setWorkspaceRoot(workspaceRoot).then(refreshAll)}>
                  Apply Root
                </button>
              </div>
              </div>

              <div className="control-card">
                <h3>Root rules</h3>
                <div className="muted">The bridge now validates this path, normalizes it, and persists it across restarts.</div>
              </div>
            </section>
          )}

          {tab === "scheduler" && (
            <section className="section-grid">
              <div className="control-card control-card-wide">
              <h2>Scheduler Control</h2>
              <div className="row">
                <input value={schedulerPrompt} onChange={(e) => setSchedulerPrompt(e.target.value)} className="control-input" />
                <button className="primary" onClick={() => void createSchedulerJob(schedulerPrompt).then(refreshAll)}>
                  + Job
                </button>
                <input value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="control-input narrow-input" />
                <button onClick={() => void createSchedulerTemplateJob(templateId).then(refreshAll)}>
                  + Template Job
                </button>
                <input value={taskStackInput} onChange={(e) => setTaskStackInput(e.target.value)} className="control-input narrow-input" />
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
              </div>

              <div className="control-card control-card-wide">
              <h3>Latest run activity</h3>
              <div className="row" style={{ marginBottom: 8 }}>
                <button
                  onClick={() => latestSchedulerFailure && void inspectRun(latestSchedulerFailure.run_id)}
                  disabled={!latestSchedulerFailure}
                >
                  Inspect latest failure
                </button>
              </div>
              <div className="list">
                {schedulerRuns.slice(0, 8).map((run) => (
                  <div key={`sched-${run.run_id}`} className="item timeline-item">
                    <div><strong>{run.run_id}</strong></div>
                    <div className="muted">task: {run.task_id}</div>
                    <div className="muted">{run.description}</div>
                    <div className="muted">created: {formatTimestamp(run.created_at)}</div>
                    <div className="muted">completed: {formatTimestamp(run.completed_at)}</div>
                    <div className={`badge ${statusClass(run.status)}`}>{run.status}</div>
                    {run.error && <div className="badge status-failed">error: {run.error}</div>}
                    <div className="row">
                      <button onClick={() => void inspectRun(run.run_id)}>Inspect</button>
                    </div>
                  </div>
                ))}
                {schedulerRuns.length === 0 && <div className="muted">No scheduler-origin runs yet.</div>}
              </div>
              </div>

              <div className="control-card">
              <h3>Jobs</h3>
              <div className="list">
                {schedulerJobs.map((job) => (
                  <div key={job.job_id} className="item">
                    <div><strong>{job.job_id}</strong> - {job.description}</div>
                    <div className="row">
                      <button onClick={() => void setSchedulerJobEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                        {job.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="primary" onClick={() => void runAndInspect(runSchedulerJob(job.job_id))}>
                        Run
                      </button>
                      <button className="warn" onClick={() => void deleteSchedulerJob(job.job_id).then(refreshAll)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              </div>

              <div className="control-card">
              <h3>Template Jobs</h3>
              <div className="list">
                {templateJobs.map((job) => (
                  <div key={job.job_id} className="item">
                    <div><strong>{job.job_id}</strong> - {job.template_id}</div>
                    <div className="row">
                      <button onClick={() => void setSchedulerTemplateJobEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                        {job.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="primary" onClick={() => void runAndInspect(runSchedulerTemplateJob(job.job_id))}>
                        Run
                      </button>
                      <button className="warn" onClick={() => void deleteSchedulerTemplateJob(job.job_id).then(refreshAll)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              </div>

              <div className="control-card">
              <h3>Task Stacks</h3>
              <div className="list">
                {taskStacks.map((job) => (
                  <div key={job.job_id} className="item">
                    <div><strong>{job.job_id}</strong> - {job.task_ids.join(", ")}</div>
                    <div className="row">
                      <button onClick={() => void setSchedulerTaskStackEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                        {job.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="primary" onClick={() => void runAndInspect(runSchedulerTaskStack(job.job_id))}>
                        Run
                      </button>
                      <button className="warn" onClick={() => void deleteSchedulerTaskStack(job.job_id).then(refreshAll)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              </div>
            </section>
          )}

          {tab === "settings" && (
            <section className="section-grid settings-grid">
              <div className="control-card control-card-wide">
                <h2>Settings Control Deck</h2>
                <p className="muted section-copy">
                  This panel controls backend routing and provider selection. It should feel like an operator console, not a raw form dump.
                </p>
              </div>

              <div className="control-card">
                <div className="card-eyebrow">Model routing</div>
                <h3>Default backend</h3>
                <label className="field-label">model.default_backend</label>
                <input value={modelBackend} onChange={(e) => setModelBackend(e.target.value)} className="control-input control-input-wide" />
                <div className="row">
                  <button className="primary" onClick={() => void updateConfig("model.default_backend", modelBackend).then(refreshAll)}>
                    Save model backend
                  </button>
                </div>
                <p className="muted">This backend is used when a request does not provide an explicit model backend.</p>
              </div>

              <div className="control-card">
                <div className="card-eyebrow">Provider routing</div>
                <h3>Provider default model</h3>
                <label className="field-label">provider</label>
                <select value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)} className="control-input control-input-wide">
                  <option value="">Select provider</option>
                  {providerOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} ({provider.id})
                    </option>
                  ))}
                </select>
                <label className="field-label">provider.default_model</label>
                <input value={providerDefaultModel} onChange={(e) => setProviderDefaultModel(e.target.value)} className="control-input control-input-wide" />
                <div className="row">
                  <button onClick={() => void saveProviderModel()}>Save provider.default_model</button>
                  <button
                    onClick={() => void applyProviderDefault()}
                    disabled={!selectedProvider || !providerDefaults[selectedProvider]}
                  >
                    Use provider default
                  </button>
                </div>
                <p className="muted">
                  Selected provider default: {selectedProvider ? providerDefaults[selectedProvider] || "(none)" : "(select a provider)"}
                </p>
              </div>

              <div className="control-card control-card-wide">
                <div className="card-eyebrow">Detected providers</div>
                <h3>Available provider defaults</h3>
                <div className="provider-grid">
                  {providerDefaultEntries.length > 0 ? (
                    providerDefaultEntries.map(([providerId, defaultModel]) => (
                      <div key={providerId} className="provider-item">
                        <div className="provider-name">{providerId}</div>
                        <div className="provider-model">{defaultModel}</div>
                      </div>
                    ))
                  ) : (
                    <div className="muted">No provider defaults detected from the backend yet.</div>
                  )}
                </div>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
