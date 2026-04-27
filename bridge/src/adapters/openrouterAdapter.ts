import { randomUUID } from "node:crypto"
import type { ChatRequest, ChatResponse } from "../types.js"

const OPENROUTER_BASE = "https://openrouter.ai/api/v1"

export type OpenRouterAdapterResult = ChatResponse & {
  session_id?: string
  tool_calls?: never[]
}

/**
 * Direct OpenRouter adapter — calls OpenRouter's OpenAI-compatible completions
 * API without any dependency on a local OpenCode backend.
 */
export class OpenRouterDirectAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async runChat(prompt: string): Promise<OpenRouterAdapterResult> {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "http://127.0.0.1:5173",
        "X-Title": "TitanShift",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      return {
        success: false,
        response: "",
        model: this.model,
        mode: "error",
        error: `openrouter_error: ${response.status} ${body}`,
      }
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      model?: string
      error?: { message?: string }
    }

    if (data.error) {
      return {
        success: false,
        response: "",
        model: this.model,
        mode: "error",
        error: data.error.message ?? "openrouter_unknown_error",
      }
    }

    const content = data.choices?.[0]?.message?.content ?? ""

    return {
      success: true,
      response: content,
      model: data.model ?? this.model,
      mode: "reactive",
      workflow_mode: "lightning",
      session_id: randomUUID(),
      tool_calls: [],
    }
  }

  /**
   * Streaming variant — yields text chunks via callback, returns the full result.
   */
  async streamChat(
    prompt: string,
    onChunk: (text: string) => void,
  ): Promise<OpenRouterAdapterResult> {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "http://127.0.0.1:5173",
        "X-Title": "TitanShift",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
    })

    if (!response.ok || !response.body) {
      const body = await response.text()
      return {
        success: false,
        response: "",
        model: this.model,
        mode: "error",
        error: `openrouter_stream_error: ${response.status} ${body}`,
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let fullText = ""
    let resolvedModel = this.model

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (raw === "[DONE]") continue

        try {
          const chunk = JSON.parse(raw) as {
            choices?: Array<{ delta?: { content?: string } }>
            model?: string
          }
          if (chunk.model) resolvedModel = chunk.model
          const delta = chunk.choices?.[0]?.delta?.content ?? ""
          if (delta) {
            fullText += delta
            onChunk(delta)
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }

    return {
      success: true,
      response: fullText,
      model: resolvedModel,
      mode: "reactive",
      workflow_mode: "lightning",
      session_id: randomUUID(),
      tool_calls: [],
    }
  }
}

/**
 * Test connectivity to OpenRouter with just a models list fetch (no tokens used).
 */
export async function checkOpenRouterConnectivity(apiKey: string): Promise<{
  ok: boolean
  error?: string
}> {
  try {
    const response = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (response.ok) return { ok: true }
    return { ok: false, error: `${response.status} ${response.statusText}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network_error" }
  }
}
