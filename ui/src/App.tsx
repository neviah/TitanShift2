import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import {
  cancelTask,
  checkOpenRouterKey,
  createSchedulerJob,
  createSchedulerTaskStack,
  createSchedulerTemplateJob,
  deleteSchedulerJob,
  deleteSchedulerTaskStack,
  deleteSchedulerTemplateJob,
  fetchConfig,
  fetchConfigProviders,
  fetchHealthStatus,
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
  thinking?: string
  pending?: boolean
  runId?: string
  runStatus?: "queued" | "running" | "completed" | "failed" | "cancelled"
  workflowMode?: string
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
  const [workspaceHistory, setWorkspaceHistory] = useState<string[]>([])
  const [apiKeyTestStatus, setApiKeyTestStatus] = useState<"idle" | "testing" | "success" | "failed">("idle")
  const [apiKeyTestMessage, setApiKeyTestMessage] = useState("")
  const [healthStatus, setHealthStatus] = useState<{
    bridge: boolean
    opencode: boolean
    openrouter_configured: boolean
  } | null>(null)
  const chatThreadRef = useRef<HTMLDivElement | null>(null)
  const schedulerRuns = runs.filter((run) => run.description.startsWith("Scheduler:"))
  const latestSchedulerFailure = schedulerRuns.find((run) => run.status === "failed")
  const recentRuns = runs.slice(0, 5)

  useEffect(() => {
    // Load workspace history from localStorage
    const savedHistory = localStorage.getItem("titanshift-workspace-history")
    if (savedHistory) {
      try {
        const parsed = JSON.parse(savedHistory) as string[]
        setWorkspaceHistory(parsed)
      } catch {
        // ignore parse error
      }
    }
    void refreshAll()
  }, [])

  // Poll health status every 10s
  useEffect(() => {
    async function pollHealth() {
      try {
        const h = await fetchHealthStatus()
        setHealthStatus(h.services)
      } catch {
        setHealthStatus({ bridge: false, opencode: false, openrouter_configured: false })
      }
    }
    void pollHealth()
    const interval = setInterval(() => { void pollHealth() }, 10000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!chatThreadRef.current) return
    chatThreadRef.current.scrollTop = chatThreadRef.current.scrollHeight
  }, [chatMessages])

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
    setProviderApiKey(String(config["provider.openrouter_api_key"] ?? ""))
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
    const updateAssistant = (updater: (message: ChatMessage) => ChatMessage) => {
      setChatMessages((prev) => prev.map((msg) => (msg.id === assistantMessageId ? updater(msg) : msg)))
    }

    setChatMessages((prev) => [
      ...prev,
      { id: userMessageId, role: "user", content: userPrompt },
      { id: assistantMessageId, role: "assistant", content: "", pending: true, runStatus: "queued" },
    ])
    setPrompt("")

    setStreaming(true)
    let streamedRunId = ""
    try {
      await streamChat(userPrompt, (event: StreamEvent) => {
        if (event.type === "start" && typeof event.run_id === "string") {
          const runId = event.run_id
          streamedRunId = runId
          setActiveRunId(runId)
          updateAssistant((msg) => ({
            ...msg,
            runId,
            runStatus: "running",
            workflowMode: typeof event.workflow_mode === "string" ? event.workflow_mode : msg.workflowMode,
          }))
          return
        }

        if (event.type === "text_delta") {
          const chunk = typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : ""
          if (!chunk) return
          updateAssistant((msg) => ({ ...msg, content: `${msg.content}${chunk}` }))
          return
        }

        if (event.type === "reasoning_delta") {
          const chunk = typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : ""
          if (!chunk) return
          updateAssistant((msg) => ({ ...msg, thinking: `${msg.thinking ?? ""}${chunk}` }))
          return
        }

        if (event.type === "done") {
          updateAssistant((msg) => ({
            ...msg,
            runStatus: event.success === false ? "failed" : "completed",
            workflowMode: typeof event.workflow_mode === "string" ? event.workflow_mode : msg.workflowMode,
          }))
          return
        }

        if (event.type === "error") {
          const errorText = typeof event.error === "string" ? event.error : "stream_error"
          updateAssistant((msg) => ({
            ...msg,
            runStatus: "failed",
            content: msg.content || `Request failed: ${errorText}`,
          }))
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
      updateAssistant((msg) => ({
        ...msg,
        content: fallbackText,
        runId: fallback.run_id ?? msg.runId,
        runStatus: fallback.success ? "completed" : "failed",
      }))
      if (fallback.run_id) {
        setActiveRunId(fallback.run_id)
        const detail = await fetchRun(fallback.run_id)
        setSelectedRun(detail)
      }
      await refreshAll()
    } finally {
      updateAssistant((msg) => ({ ...msg, pending: false, content: msg.content || "No response" }))
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
    await updateConfig("provider.openrouter_api_key", providerMode === "openrouter" ? providerApiKey : "")
    await refreshAll()
  }

  async function switchWorkspace(path: string) {
    await setWorkspaceRoot(path)
    
    // Track in history
    const updated = [path, ...workspaceHistory.filter((w) => w !== path)].slice(0, 10)
    setWorkspaceHistory(updated)
    localStorage.setItem("titanshift-workspace-history", JSON.stringify(updated))
    
    await refreshAll()
  }

  async function testOpenRouterApiKey() {
    if (!providerApiKey.trim()) {
      setApiKeyTestStatus("failed")
      setApiKeyTestMessage("API key cannot be empty")
      return
    }

    setApiKeyTestStatus("testing")
    setApiKeyTestMessage("Testing connection...")

    try {
      const result = await checkOpenRouterKey(providerApiKey)
      if (result.ok) {
        setApiKeyTestStatus("success")
        setApiKeyTestMessage("API key is valid ✓")
        setTimeout(() => setApiKeyTestStatus("idle"), 3000)
      } else {
        setApiKeyTestStatus("failed")
        setApiKeyTestMessage(result.error ?? "Invalid API key")
      }
    } catch {
      setApiKeyTestStatus("failed")
      setApiKeyTestMessage("Connection error — check bridge is running")
    }
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

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void handleSendChat()
    }
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
              {healthStatus && (
                <div className="connection-status-row">
                  <span className={`conn-dot ${healthStatus.bridge ? "conn-ok" : "conn-fail"}`} title="Bridge" />
                  <span className="conn-label">Bridge</span>
                  <span className={`conn-dot ${healthStatus.opencode ? "conn-ok" : "conn-fail"}`} title="OpenCode" />
                  <span className="conn-label">OpenCode</span>
                  <span className={`conn-dot ${healthStatus.openrouter_configured ? "conn-ok" : "conn-warn"}`} title="OpenRouter" />
                  <span className="conn-label">OpenRouter</span>
                </div>
              )}
            </div>
          </div>

          {tab === "chat" && (
            <section className="chat-section">
              <div className="chat-window">
                <div ref={chatThreadRef} className="chat-thread-unified">
                  {chatMessages.length === 0 && (
                    <div className="chat-empty">Send a message to start a conversation.</div>
                  )}
                  {chatMessages.map((message) => (
                    <div
                      key={message.id}
                      className={`chat-msg ${message.role === "user" ? "chat-msg-user" : "chat-msg-ai"}`}
                    >
                      <div className="chat-msg-role">
                        {message.role === "user" ? "You" : "TitanShift"}
                      </div>

                      {/* Collapsible thinking/reasoning block — shown for AI messages only */}
                      {message.role === "assistant" && message.thinking && (
                        <details className="thinking-block">
                          <summary className="thinking-summary">
                            {message.runStatus === "running" ? "Thinking…" : "Reasoning"}
                          </summary>
                          <pre className="thinking-content">{message.thinking}</pre>
                        </details>
                      )}

                      <div className="chat-msg-content">
                        {message.content || (message.pending && !message.thinking ? (
                          <span className="chat-pending-dots">
                            <span />
                            <span />
                            <span />
                          </span>
                        ) : null)}
                      </div>

                      {message.role === "assistant" && (message.runId || message.runStatus) && (
                        <div className="chat-meta-row">
                          {message.runStatus && (
                            <span className={`badge ${statusClass(message.runStatus)}`}>{message.runStatus}</span>
                          )}
                          {message.workflowMode && (
                            <span className="badge status-queued">{message.workflowMode}</span>
                          )}
                          {message.runId && (
                            <span className="badge status-cancelled" title={message.runId}>
                              run {message.runId.slice(0, 8)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="chat-input-dock">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    rows={3}
                    className="chat-input-area"
                    placeholder="Type your message… (Enter to send, Shift+Enter for newline)"
                  />
                  <button
                    className="primary chat-send-btn"
                    onClick={() => void handleSendChat()}
                    disabled={streaming || !prompt.trim()}
                  >
                    {streaming ? "…" : "Send"}
                  </button>
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
              <p className="muted section-copy">Set the active execution root used by all bridge operations.</p>
              <label className="field-label">Current workspace</label>
              <input value={workspaceRoot} onChange={(e) => setWorkspaceRootState(e.target.value)} className="control-input control-input-wide" placeholder="/path/to/workspace" />
              <div className="row">
                <button className="primary" onClick={() => void switchWorkspace(workspaceRoot)}>
                  Apply Root
                </button>
              </div>
              </div>

              {workspaceHistory.length > 0 && (
                <div className="control-card control-card-wide">
                <h3>Recent workspaces</h3>
                <p className="muted">Click to quickly switch between previously used workspaces.</p>
                <div className="list">
                  {workspaceHistory.map((path) => (
                    <div key={path} className="item">
                      <div className="muted" style={{ fontSize: "12px", wordBreak: "break-all" }}>{path}</div>
                      <div className="row">
                        <button 
                          className={workspaceRoot === path ? "primary" : ""} 
                          onClick={() => void switchWorkspace(path)}
                        >
                          {workspaceRoot === path ? "✓ Active" : "Switch"}
                        </button>
                        <button 
                          className="warn" 
                          onClick={() => {
                            const updated = workspaceHistory.filter((w) => w !== path)
                            setWorkspaceHistory(updated)
                            localStorage.setItem("titanshift-workspace-history", JSON.stringify(updated))
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                </div>
              )}

              <div className="control-card">
                <h3>Workspace rules</h3>
                <div className="muted">
                  The bridge validates each path, normalizes it, and persists the current workspace across restarts. 
                  Your workspace history is stored locally in your browser.
                </div>
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
                {schedulerJobs.length === 0 ? (
                  <div className="muted">No jobs created yet.</div>
                ) : (
                  schedulerJobs.map((job) => (
                    <div key={job.job_id} className="item">
                      <div className="row">
                        <strong>{job.job_id}</strong>
                        <span className={`badge ${job.enabled ? "status-running" : "status-cancelled"}`}>
                          {job.enabled ? "active" : "paused"}
                        </span>
                      </div>
                      <div className="muted">{job.description}</div>
                      <div className="muted">
                        schedule: {job.schedule_type === "interval" ? `every ${job.interval_seconds}s` : `cron: ${job.cron}`}
                      </div>
                      <div className="row">
                        <button onClick={() => void setSchedulerJobEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                          {job.enabled ? "Pause" : "Resume"}
                        </button>
                        <button className="primary" onClick={() => void runAndInspect(runSchedulerJob(job.job_id))}>
                          Run now
                        </button>
                        <button className="warn" onClick={() => void deleteSchedulerJob(job.job_id).then(refreshAll)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              </div>

              <div className="control-card">
              <h3>Template Jobs</h3>
              <div className="list">
                {templateJobs.length === 0 ? (
                  <div className="muted">No template jobs created yet.</div>
                ) : (
                  templateJobs.map((job) => (
                    <div key={job.job_id} className="item">
                      <div className="row">
                        <strong>{job.job_id}</strong>
                        <span className={`badge ${job.enabled ? "status-running" : "status-cancelled"}`}>
                          {job.enabled ? "active" : "paused"}
                        </span>
                      </div>
                      <div className="muted">template: {job.template_id}</div>
                      <div className="muted">
                        schedule: {job.schedule_type === "interval" ? `every ${job.interval_seconds}s` : `cron: ${job.cron}`}
                      </div>
                      <div className="row">
                        <button onClick={() => void setSchedulerTemplateJobEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                          {job.enabled ? "Pause" : "Resume"}
                        </button>
                        <button className="primary" onClick={() => void runAndInspect(runSchedulerTemplateJob(job.job_id))}>
                          Run now
                        </button>
                        <button className="warn" onClick={() => void deleteSchedulerTemplateJob(job.job_id).then(refreshAll)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              </div>

              <div className="control-card">
              <h3>Task Stacks</h3>
              <div className="list">
                {taskStacks.length === 0 ? (
                  <div className="muted">No task stacks created yet.</div>
                ) : (
                  taskStacks.map((job) => (
                    <div key={job.job_id} className="item">
                      <div className="row">
                        <strong>{job.job_id}</strong>
                        <span className={`badge ${job.enabled ? "status-running" : "status-cancelled"}`}>
                          {job.enabled ? "active" : "paused"}
                        </span>
                      </div>
                      <div className="muted">tasks: {job.task_ids.join(", ")}</div>
                      <div className="muted">
                        schedule: {job.schedule_type === "interval" ? `every ${job.interval_seconds}s` : `cron: ${job.cron}`}
                      </div>
                      <div className="row">
                        <button onClick={() => void setSchedulerTaskStackEnabled(job.job_id, !job.enabled).then(refreshAll)}>
                          {job.enabled ? "Pause" : "Resume"}
                        </button>
                        <button className="primary" onClick={() => void runAndInspect(runSchedulerTaskStack(job.job_id))}>
                          Run now
                        </button>
                        <button className="warn" onClick={() => void deleteSchedulerTaskStack(job.job_id).then(refreshAll)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              </div>
            </section>
          )}

          {tab === "settings" && (
            <section className="section-grid settings-grid">
              <div className="control-card control-card-wide">
                <h2>Settings</h2>
                <p className="muted section-copy">
                  Configure your model provider, select a model, and add authentication when needed.
                </p>
              </div>

              <div className="control-card control-card-wide">
                <div className="card-eyebrow">Provider Configuration</div>
                <h3>Select provider</h3>
                <label className="field-label">Model provider</label>
                <select
                  value={providerMode}
                  onChange={(e) => {
                    setProviderMode(e.target.value as ProviderMode)
                    setApiKeyTestStatus("idle")
                  }}
                  className="control-input control-input-wide"
                >
                  <option value="local">Local (LM Studio)</option>
                  <option value="openrouter">OpenRouter</option>
                </select>

                {providerMode === "local" && (
                  <div className="muted" style={{ marginTop: "10px", fontSize: "12px" }}>
                    Requires LM Studio running locally at <strong>http://localhost:1234</strong>
                  </div>
                )}

                {providerMode === "openrouter" && (
                  <div className="muted" style={{ marginTop: "10px", fontSize: "12px" }}>
                    Get your API key at <strong>https://openrouter.ai/keys</strong>
                  </div>
                )}

                <label className="field-label">Model name</label>
                <input
                  value={providerDefaultModel}
                  onChange={(e) => setProviderDefaultModel(e.target.value)}
                  className="control-input control-input-wide"
                  placeholder={providerMode === "openrouter" ? "openai/gpt-4-turbo" : "local-model"}
                />

                {providerMode === "openrouter" && (
                  <>
                    <label className="field-label">OpenRouter API key</label>
                    <input
                      value={providerApiKey}
                      onChange={(e) => {
                        setProviderApiKey(e.target.value)
                        setApiKeyTestStatus("idle")
                      }}
                      className="control-input control-input-wide"
                      placeholder="sk-or-v1-..."
                      type="password"
                    />
                    <div className="row" style={{ marginTop: "10px" }}>
                      <button
                        onClick={() => void testOpenRouterApiKey()}
                        disabled={apiKeyTestStatus === "testing"}
                      >
                        {apiKeyTestStatus === "testing" ? "Testing..." : "Test API Key"}
                      </button>
                      {apiKeyTestStatus !== "idle" && (
                        <span
                          className={`badge ${
                            apiKeyTestStatus === "success"
                              ? "status-completed"
                              : "status-failed"
                          }`}
                        >
                          {apiKeyTestMessage}
                        </span>
                      )}
                    </div>
                  </>
                )}

                <div className="row" style={{ marginTop: "16px" }}>
                  <button className="primary" onClick={() => void saveSimpleProviderSettings()}>
                    Save Settings
                  </button>
                </div>
                <p className="muted" style={{ marginTop: "10px" }}>Current backend: <strong>{modelBackend || "(unset)"}</strong></p>
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
