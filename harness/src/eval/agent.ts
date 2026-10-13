/**
 * eval/agent.ts — the minimal, model-agnostic eval agent.
 *
 * One chat-completion call per step, one tool call at a time is NOT assumed:
 * the model may return several tool_calls per turn and they are all executed.
 * The loop ends when the model stops calling tools (final answer) or when
 * maxToolSteps is hit (recorded as agentError, the artifact still counts if
 * it is good — the suite is what is scored).
 *
 * Transport:
 *  - model: any OpenAI-compatible /chat/completions endpoint (llama.cpp
 *    llama-server locally, or a hosted provider via EVAL_API_*)
 *  - tools: the harness MCP server over stdio — the same 15 tools an external
 *    MCP client (pi, Claude Desktop, ...) would use
 *
 * Config (env, see cli.ts defaults):
 *   EVAL_API_BASE  e.g. http://127.0.0.1:8080/v1
 *   EVAL_API_MODEL model name as the server knows it
 *   EVAL_API_KEY   optional; local servers ignore it
 *   EVAL_TEMPERATURE            default 0
 *   EVAL_MAX_TOOL_STEPS         default 25
 *   EVAL_THINKING               "1" to enable Qwen-style reasoning tokens
 *                               (default off: fast, deterministic, cheaper)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface AgentConfig {
  apiBase: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxToolSteps: number;
}

export interface ToolCallRecord {
  step: number;
  name: string;
  args: unknown;
  ok: boolean;
  /** result text, truncated (full text was sent to the model) */
  text: string;
  durationMs: number;
}

export interface AgentResult {
  toolCalls: ToolCallRecord[];
  tokensIn: number;
  tokensOut: number;
  finalText: string;
  wallMs: number;
  /** set when the loop could not finish cleanly (API error, max steps) */
  error: string | null;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices: { message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Keep reports bounded: full tool results can be KB sections / schemas. */
const MAX_RECORD_TEXT = 2000;

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toolResultText(r: CallToolResult): string {
  return r.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
}

export class Agent {
  private tools: {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[] = [];

  constructor(
    private cfg: AgentConfig,
    private mcp: Client,
  ) {}

  /** Discover the MCP tool surface once; the surface is fixed per server. */
  async discoverTools(): Promise<void> {
    const listed = await this.mcp.listTools();
    this.tools = listed.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      },
    }));
  }

  private async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const base = this.cfg.apiBase.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        tools: this.tools,
        temperature: this.cfg.temperature,
        // Qwen3 chat template: disable reasoning tokens. Ignored by servers
        // that don't know it; set EVAL_THINKING=1 to turn reasoning on.
        ...(process.env.EVAL_THINKING === "1" ? {} : { chat_template_kwargs: { enable_thinking: false } }),
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(`chat API ${res.status} from ${base}: ${body}`);
    }
    return (await res.json()) as ChatResponse;
  }

  async run(systemPrompt: string, userPrompt: string): Promise<AgentResult> {
    const t0 = Date.now();
    const result: AgentResult = {
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      finalText: "",
      wallMs: 0,
      error: null,
    };
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    try {
      for (let step = 1; step <= this.cfg.maxToolSteps; step++) {
        const resp = await this.chat(messages);
        const choice = resp.choices[0];
        if (!choice) throw new Error("chat response had no choices");
        if (resp.usage) {
          result.tokensIn += resp.usage.prompt_tokens ?? 0;
          result.tokensOut += resp.usage.completion_tokens ?? 0;
        }
        const m = choice.message;
        if (!m.tool_calls || m.tool_calls.length === 0) {
          result.finalText = m.content ?? "";
          break;
        }
        messages.push({ role: "assistant", content: m.content, tool_calls: m.tool_calls });
        for (const tc of m.tool_calls) {
          const callT0 = Date.now();
          let ok = true;
          let text: string;
          try {
            const r = (await this.mcp.callTool({
              name: tc.function.name,
              arguments: safeParse(tc.function.arguments) as Record<string, unknown>,
            })) as unknown as CallToolResult;
            text = toolResultText(r);
            ok = r.isError !== true;
          } catch (e) {
            ok = false;
            text = e instanceof Error ? e.message : String(e);
          }
          result.toolCalls.push({
            step,
            name: tc.function.name,
            args: safeParse(tc.function.arguments),
            ok,
            text: text.slice(0, MAX_RECORD_TEXT),
            durationMs: Date.now() - callT0,
          });
          messages.push({ role: "tool", tool_call_id: tc.id, content: text });
        }
      }
      if (!result.finalText) {
        result.error = `no final answer after ${this.cfg.maxToolSteps} tool steps`;
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    result.wallMs = Date.now() - t0;
    return result;
  }
}
