import { access } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { ChatRequest, ChatResponse, ConfigProvidersResponse } from "../types.js"

const ToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).optional(),
})

type AdapterInput = {
  taskId: string
  runId: string
  workspaceRoot: string
  payload: ChatRequest
}

export type AdapterResult = ChatResponse & {
  session_id?: string
  tool_calls?: Array<z.infer<typeof ToolCallSchema>>
}

export interface ExecutionAdapter {
  runChat(input: AdapterInput): Promise<AdapterResult>
  abortSession(sessionId: string, workspaceRoot?: string): Promise<boolean>
  fetchConfigProviders(workspaceRoot?: string): Promise<ConfigProvidersResponse>
}

export class OpenCodeHttpAdapter implements ExecutionAdapter {
  constructor(private readonly baseUrl: string) {}

  async runChat(input: AdapterInput): Promise<AdapterResult> {
    const directoryQuery = `?directory=${encodeURIComponent(input.workspaceRoot)}`

    const createSession = await fetch(`${this.baseUrl}/session${directoryQuery}`, {
      method: "POST",
      headers: buildBridgeHeaders(input.payload.openrouter_api_key),
      body: JSON.stringify({ title: input.payload.prompt.slice(0, 80) }),
    })

    if (!createSession.ok) {
      const body = await safeJson(createSession)
      return {
        success: false,
        response: "",
        model: "unknown",
        mode: "error",
        error: `session_create_failed: ${JSON.stringify(body)}`,
      }
    }

    const session = (await createSession.json()) as { id?: string }
    const sessionId = String(session.id ?? "")
    if (!sessionId) {
      return {
        success: false,
        response: "",
        model: "unknown",
        mode: "error",
        error: "session_create_failed: missing session id",
      }
    }

    const promptReq = await fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message${directoryQuery}`,
      {
        method: "POST",
        headers: buildBridgeHeaders(input.payload.openrouter_api_key),
        body: JSON.stringify({
          parts: [{ type: "text", text: input.payload.prompt }],
        }),
      },
    )

    const body = await safeJson(promptReq)
    if (!promptReq.ok) {
      return {
        success: false,
        response: "",
        model: "unknown",
        mode: "error",
        error: `message_failed: ${JSON.stringify(body)}`,
        session_id: sessionId,
      }
    }

    const parts = Array.isArray((body as any)?.parts) ? (body as any).parts : []
    const responseText = parts
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text as string)
      .join("\n")
      .trim()

    const result: AdapterResult = {
      success: true,
      response: responseText,
      model: input.payload.model_backend ?? "opencode-default",
      mode: "reactive",
      workflow_mode: input.payload.workflow_mode ?? "lightning",
      task_id: input.taskId,
      run_id: input.runId,
      session_id: sessionId,
      used_tools: [],
      created_paths: [],
      updated_paths: [],
      patch_summaries: [],
      tool_calls: [],
    }

    await enforceExecutionIntegrity(result, input.workspaceRoot)
    return result
  }

  async abortSession(sessionId: string, workspaceRoot?: string): Promise<boolean> {
    const query = workspaceRoot ? `?directory=${encodeURIComponent(workspaceRoot)}` : ""
    const response = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    return response.ok
  }

  async fetchConfigProviders(workspaceRoot?: string): Promise<ConfigProvidersResponse> {
    const query = workspaceRoot ? `?directory=${encodeURIComponent(workspaceRoot)}` : ""
    const response = await fetch(`${this.baseUrl}/config/providers${query}`)
    if (!response.ok) {
      return { providers: [], default: {} }
    }

    const body = await safeJson(response)
    if (!isConfigProvidersResponse(body)) {
      return { providers: [], default: {} }
    }
    return body
  }
}

function buildBridgeHeaders(openrouterApiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (openrouterApiKey) {
    headers["x-openrouter-api-key"] = openrouterApiKey
  }
  return headers
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return { message: "non-json response" }
  }
}

export async function enforceExecutionIntegrity(result: AdapterResult, workspaceRoot: string): Promise<void> {
  if (!result.success) return

  const toolCalls = Array.isArray(result.tool_calls) ? result.tool_calls : []
  for (const call of toolCalls) {
    const parsed = ToolCallSchema.safeParse(call)
    if (!parsed.success) {
      throw new Error("invalid_tool_call_shape")
    }

    if (requiresArguments(parsed.data.name) && (!parsed.data.args || Object.keys(parsed.data.args).length === 0)) {
      throw new Error(`invalid_tool_args:${parsed.data.name}`)
    }
  }

  const fileMutationRequested = (result.used_tools ?? []).some((tool) => isFileMutationTool(tool))
  if (!fileMutationRequested) return

  const candidatePaths = [...(result.created_paths ?? []), ...(result.updated_paths ?? [])]
  if (candidatePaths.length === 0) {
    throw new Error("file_mutation_without_side_effects")
  }

  let anyVisible = false
  for (const relPath of candidatePaths) {
    const full = path.resolve(workspaceRoot, relPath)
    try {
      await access(full, fsConstants.F_OK)
      anyVisible = true
      break
    } catch {
      continue
    }
  }

  if (!anyVisible) {
    throw new Error("file_mutation_evidence_missing")
  }
}

function isFileMutationTool(name: string): boolean {
  return new Set([
    "create_file",
    "apply_patch",
    "str_replace",
    "insert",
    "delete",
    "rename",
    "write_file",
  ]).has(name)
}

function requiresArguments(name: string): boolean {
  return !new Set(["date", "pwd", "ls"]).has(name)
}

function isConfigProvidersResponse(value: unknown): value is ConfigProvidersResponse {
  if (!value || typeof value !== "object") return false
  const data = value as Record<string, unknown>
  return Array.isArray(data.providers) && typeof data.default === "object" && data.default !== null
}
