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
type ProviderMode = "local" | "openrouter"
type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  pending?: boolean
}

export function App() {
  const [tab, setTab] = useState<Tab>("chat")
  const [prompt, setPrompt] = useState("")
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
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
  const [providerMode, setProviderMode] = useState<ProviderMode>("local")
  const [providerApiKey, setProviderApiKey] = useState("")
  const [schedulerPrompt, setSchedulerPrompt] = useState("Say hello from scheduler")
  const [templateId, setTemplateId] = useState("template-default")
  const [taskStackInput, setTaskStackInput] = useState("task-1,task-2")
  const [tickSummary, setTickSummary] = useState("")
  const schedulerRuns = runs.filter((run) => run.description.startsWith("Scheduler:"))
  const latestSchedulerFailure = schedulerRuns.find((run) => run.status === "failed")
  const recentRuns = runs.slice(0, 5)

  useEffect(() => {
    void refreshAll()
  }, [])

  useEffect(() => {
    const storedApiKey = window.localStorage.getItem("titanshift.providerApiKey")
    if (storedApiKey) {
      setProviderApiKey(storedApiKey)
    }
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
    const backendLower = String(config["model.default_backend"] ?? "").toLowerCase()
    setProviderMode(backendLower.includes("openrouter") ? "openrouter" : "local")

    const openrouterDefault =
      providers.default && typeof providers.default === "object" && "openrouter" in providers.default
        ? providers.default.openrouter
        : undefined
    if (!String(config["provider.default_model"] ?? "") && typeof openrouterDefault === "string") {
      setProviderDefaultModel(openrouterDefault)
    }
    setSchedulerJobs(jobs)
    setTemplateJobs(templates)
    setTaskStacks(stacks)
  }

  async function handleSendChat() {
    const userPrompt = prompt.trim()
    if (!userPrompt || streaming) return

    const userMessageId = `u-${Date.now()}`
    const assistantMessageId = `a-${Date.now()}`
    setChatMessages((prev) => [
      ...prev,
      { id: userMessageId, role: "user", content: userPrompt },
      { id: assistantMessageId, role: "assistant", content: "", pending: true },
    ])
    setPrompt("")

    setStreaming(true)
    let streamedRunId = ""
    try {
      await streamChat(userPrompt, (event: StreamEvent) => {
        if (event.type === "start" && typeof event.run_id === "string") {
          streamedRunId = event.run_id
          setActiveRunId(event.run_id)
        }
        if (event.type === "text_delta" && typeof event.delta === "string") {
          setChatMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId ? { ...msg, content: `${msg.content}${event.delta}` } : msg,
            ),
          )
        }
      })

      await refreshAll()
      if (streamedRunId) {
        const detail = await fetchRun(streamedRunId)
        setSelectedRun(detail)
      }
    } catch (error) {
      const fallback = await sendChat(userPrompt)
      const fallbackText = fallback.response || fallback.error || `Request failed: ${String(error)}`
      setChatMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId ? { ...msg, content: fallbackText } : msg,
        ),
      )
      if (fallback.run_id) {
        setActiveRunId(fallback.run_id)
        const detail = await fetchRun(fallback.run_id)
        setSelectedRun(detail)
      }
      await refreshAll()
    } finally {
      setChatMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId ? { ...msg, pending: false, content: msg.content || "No response" } : msg,
        ),
      )
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

  async function saveSimpleProviderSettings() {
    const backendValue = providerMode === "openrouter" ? "openrouter" : "lmstudio"
    await updateConfig("model.default_backend", backendValue)
    await updateConfig("provider.default_model", providerDefaultModel)
    window.localStorage.setItem("titanshift.providerApiKey", providerApiKey)
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

  return (
    <div className="app-shell">
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-topline">TitanShift</div>
          <div className="logo">TITANSHIFT</div>
          <p className="muted">Control Surface</p>
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
              <div className="panel-kicker">TitanShift Panel</div>
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
                <h2>Chat</h2>
                <p className="muted section-copy">One conversation window. Responses stream directly into the same thread.</p>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="control-input prompt-area"
                placeholder="Type your request..."
              />
              <div className="row">
                <button className="primary" onClick={() => void handleSendChat()} disabled={streaming || !prompt.trim()}>
                  {streaming ? "Sending..." : "Send"}
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
              <h3>Conversation</h3>
              <div className="chat-thread">
                {chatMessages.length === 0 && <div className="muted">No messages yet.</div>}
                {chatMessages.map((message) => (
                  <div key={message.id} className={`chat-bubble ${message.role === "user" ? "chat-bubble-user" : "chat-bubble-assistant"}`}>
                    <div className="chat-role">{message.role === "user" ? "You" : "TitanShift"}</div>
                    <div className="chat-content">{message.content || (message.pending ? "..." : "No response")}</div>
                  </div>
                ))}
              </div>
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
                <h2>Settings</h2>
                <p className="muted section-copy">
                  Keep this simple: pick provider type, set model name, and add API key when using OpenRouter.
                </p>
              </div>

              <div className="control-card control-card-wide">
                <div className="card-eyebrow">Model Setup</div>
                <h3>Provider and model</h3>
                <label className="field-label">Provider</label>
                <select
                  value={providerMode}
                  onChange={(e) => setProviderMode(e.target.value as ProviderMode)}
                  className="control-input control-input-wide"
                >
                  <option value="local">Local (LM Studio)</option>
                  <option value="openrouter">OpenRouter</option>
                </select>

                <label className="field-label">Model name</label>
                <input
                  value={providerDefaultModel}
                  onChange={(e) => setProviderDefaultModel(e.target.value)}
                  className="control-input control-input-wide"
                  placeholder={providerMode === "openrouter" ? "openai/gpt-4.1-mini" : "google/gemma-3-4b"}
                />

                {providerMode === "openrouter" && (
                  <>
                    <label className="field-label">OpenRouter API key</label>
                    <input
                      value={providerApiKey}
                      onChange={(e) => setProviderApiKey(e.target.value)}
                      className="control-input control-input-wide"
                      placeholder="sk-or-v1-..."
                      type="password"
                    />
                  </>
                )}

                <div className="row">
                  <button className="primary" onClick={() => void saveSimpleProviderSettings()}>
                    Save
                  </button>
                </div>
                <p className="muted">Current backend key: {modelBackend || "(unset)"}</p>
              </div>
            </section>
          )}
        </main>

        <aside className="run-pane">
          <div className="run-pane-header">Run</div>
          <div className="run-pane-tabs">
            <span className="run-tab active">Logs</span>
            <span className="run-tab">Health</span>
          </div>

          <div className="run-card">
            <div className="run-title">Current Run</div>
            <div className="run-line"><span>Task</span><strong>{selectedRun?.task_id ?? "idle"}</strong></div>
            <div className="run-line"><span>Status</span><span className={`badge ${statusClass(selectedRun?.status ?? "queued")}`}>{selectedRun?.status ?? "idle"}</span></div>
            <div className="run-line"><span>Success</span><span>{selectedRun ? String(selectedRun.success) : "-"}</span></div>
            <div className="run-line"><span>Error</span><span className="run-error">{selectedRun?.error || "none"}</span></div>
          </div>

          <div className="run-card">
            <div className="run-title">Timeline Pulse</div>
            {recentRuns.length > 0 ? (
              <div className="run-list">
                {recentRuns.map((run) => (
                  <button key={`run-pane-${run.run_id}`} className="run-list-item" onClick={() => void inspectRun(run.run_id)}>
                    <span className="run-list-id">{run.run_id.slice(0, 8)}</span>
                    <span className={`badge ${statusClass(run.status)}`}>{run.status}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="muted">No recent workflow events.</div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
