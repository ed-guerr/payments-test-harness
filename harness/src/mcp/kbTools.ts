/**
 * mcp/kbTools.ts — knowledge-base tools for the MCP server (plan §6.5).
 *
 *   kb_search(query, limit?) -> scored sections (deterministic term scoring)
 *   kb_read(path, section?)  -> full guide or one section
 *
 * MCP_NO_KB=1 starts the server WITHOUT these tools — the A/B demo that shows
 * a schema-only agent versus a KB-grounded one.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kbRead, kbSearch } from "../kb/index";

export function kbEnabled(): boolean {
  return process.env.MCP_NO_KB !== "1";
}

/** Content-only ablation: expose KB tools/schema but return no retrieved knowledge. */
export function kbContentEnabled(): boolean {
  return process.env.MCP_KB_CONTENT_OFF !== "1";
}

function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

export function registerKbTools(server: McpServer): void {
  server.registerTool(
    "kb_search",
    {
      description:
        "Search the per-directory intern guides (knowledge/) for a plain-English query. Returns scored sections — read them before authoring tests or designs so you assert real side effects, not just local acks.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(20).optional().describe("max sections (default 5)"),
      },
    },
    ({ query, limit }) => text(kbContentEnabled() ? kbSearch(query, limit ?? 5) : []),
  );

  server.registerTool(
    "kb_read",
    {
      description: "Read one intern guide (or a single section by title) from knowledge/.",
      inputSchema: {
        path: z.string().describe("guide path relative to the repo, e.g. knowledge/backend/auth_gateway.md"),
        section: z.string().optional().describe("section title, e.g. 'Messages'"),
      },
    },
    ({ path: p, section }) => text(kbContentEnabled() ? kbRead(p, section) : ""),
  );
}

/** Process name -> the guide that documents it. */
const GUIDE_FOR_PROCESS: Record<string, string> = {
  "pay-orders": "knowledge/backend/pay_orders.md",
  ledger: "knowledge/backend/ledger.md",
  "auth-gateway": "knowledge/backend/auth_gateway.md",
};

/** KB "notes" for a message (precondition + side effect) for get_message_schema. */
export function messageKbNotes(processName: string, messageName: string): string | null {
  if (!kbEnabled() || !kbContentEnabled()) return null;
  const guide = GUIDE_FOR_PROCESS[processName];
  if (!guide) return null;
  try {
    const messages = kbRead(guide, "Messages");
    const line = messages.split("\n").find((l) => l.includes(`\`${messageName}\``));
    return line ? line.replace(/^\|\s*/, "").replace(/\|\s*$/, "") : null;
  } catch {
    return null;
  }
}

/** Top KB hits for a failing message/field, attached to create_suite errors. */
export function kbHintsFor(messageOrField: string): string[] {
  if (!kbEnabled() || !kbContentEnabled()) return [];
  return kbSearch(messageOrField, 3).map((h) => `${h.path} :: ${h.section}`);
}
