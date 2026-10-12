/**
 * design/designer.ts — turns a plain-English change request into a reviewable
 * design doc grounded in the knowledge base (plan §6.6).
 *
 *   npm run design -- "<change request>"
 *   MCP_NO_KB=1 npm run design -- "<change request>"   (A/B: schema-only context)
 *
 * The deterministic mode assembles the doc from: kb_search hits (cited),
 * the registry (message catalog), and strict templates that match the repo's
 * existing conventions (X-macro messages, handler style, suite JSON). The LLM
 * mode (KB_API_KEY) rewrites the prose with the same context under a strict
 * outline. The designer PROPOSES — output is a doc for review, never applied.
 */
import fs from "node:fs";
import path from "node:path";
import { kbSearch, KbSection } from "../kb/index";
import { packageRoot } from "../backend/paths";
import type { Registry } from "../protocol/types";
import registryJson from "../protocol/registry.json";

const registry = registryJson as unknown as Registry;
const DESIGNS_DIR = (): string => path.join(packageRoot(), "..", "docs", "designs");

export interface DesignContext {
  request: string;
  kbHits: KbSection[];
  withKb: boolean;
}

export function gatherContext(request: string, limit = 5): DesignContext {
  const withKb = process.env.MCP_NO_KB !== "1";
  const kbHits = withKb ? kbSearch(request, limit) : [];
  return { request, kbHits, withKb };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Propose a message name from the request (heuristic; review before using). */
function proposeMessageName(request: string): string {
  const words = request.match(/[A-Za-z]+/g) ?? [];
  const STOP = new Set(["add", "new", "support", "for", "a", "an", "the", "to", "of", "in", "and", "that", "which", "can", "be"]);
  const meaningful = words.filter((w) => !STOP.has(w.toLowerCase())).slice(0, 2);
  if (meaningful.length === 0) return "NewMessage";
  return meaningful.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function catalogRows(): string {
  const rows: string[] = [];
  for (const [proc, d] of Object.entries(registry.procs)) {
    for (const m of d.messages) rows.push(`| ${proc} | ${m.name} | ${m.id} | ${m.direction} | ${m.size} |`);
  }
  return rows.join("\n");
}

export function renderDesign(ctx: DesignContext, generatedAt: string): string {
  const name = proposeMessageName(ctx.request);
  const title = ctx.request.replace(/[.?\s]+$/, "");
  const parts: string[] = [];
  parts.push(`# Design: ${title}`);
  parts.push(
    `> generated ${generatedAt} · designer (MCP_NO_KB=${ctx.withKb ? "0" : "1"}) · PROPOSED — review before implementing`,
  );

  parts.push(`## Summary`);
  parts.push(`Change request: "${ctx.request}"`);
  if (ctx.withKb) {
    parts.push(
      `Grounded in ${ctx.kbHits.length} knowledge-base sections (cited below). Proposed shape: a new message \`${name}\` plus the handler/forwarding changes it implies.`,
    );
  } else {
    parts.push(
      `Generated WITHOUT the knowledge base (A/B mode): context is the wire schema only. Expect fewer, less specific claims — compare against a KB-grounded run.`,
    );
  }

  parts.push(`## Affected components`);
  if (ctx.withKb && ctx.kbHits.length > 0) {
    const seen = new Set<string>();
    const rows = ctx.kbHits
      .map((h) => h.path.replace(/^knowledge\//, ""))
      .filter((p) => !seen.has(p) && seen.add(p));
    const table = ["| component | why (KB evidence) |", "|---|---|", ...rows.map((r) => `| ${r} | see cited sections below |`)].join("\n");
    parts.push(table);
    const evidence = ctx.kbHits
      .map((h) => {
        const first = h.excerpt.split("\n").filter((l) => l.trim()).slice(0, 3);
        return `- **${h.path} :: ${h.section}** (score ${h.score})\n  > ${first.join("\n  > ")}`;
      })
      .join("\n\n");
    parts.push(`### KB evidence`);
    parts.push(evidence);
  } else {
    parts.push(`| component | why |`);
    parts.push(`|---|---|`);
    parts.push(`| backend (all three processes) | schema-only mode: exact component list requires the knowledge base (run without MCP_NO_KB) |`);
  }

  parts.push(`## Proposed messages`);
  parts.push(`New X-macro list (format matches include/pay/messages.h):`);
  parts.push(
    [
      "PF_MSG_LIST(Name, T, F)",
      "    F(T, field1, u32)",
      "    F(T, field2, char[12])",
      "    F(T, field3, u16)",
      "PF_MSG_LIST_END",
    ].join("\n"),
  );
  parts.push(`Catalog row (id is a proposal — pick the next free id in the owning process's range):`);
  parts.push(`| process | ${name} | <next free id> | in | <sizeof> |`);
  parts.push(`Current catalog:`);
  parts.push(["| process | message | id | dir | size |", "|---|---|---|---|---|", catalogRows()].join("\n"));

  parts.push(`## Handler sketch`);
  parts.push(
    [
      "int handle_name(Server *srv, int client, const Envelope *env)",
      "{",
      "    Name msg;",
      "    if (env->payload_len != sizeof(msg)) return 1; /* -> ErrorAck(4) */",
      "    /* copy + validate */",
      "    /* precondition checks against the database */",
      "    /* side effects in one transaction */",
      "    /* ack */",
      "    return 0;",
      "}",
    ].join("\n"),
  );

  parts.push(`## Database changes`);
  parts.push(`-- e.g. new column / table; keep the ledger double-entry invariant`);
  parts.push(`-- (proposed — review):`);
  parts.push(`-- ALTER TABLE payments ADD COLUMN ...;`);

  parts.push(`## Risks`);
  if (ctx.withKb && ctx.kbHits.length > 0) {
    for (const h of ctx.kbHits.slice(0, 3)) {
      parts.push(`- ${h.path} :: ${h.section} — check its Risks section before touching this area`);
    }
  } else {
    parts.push(`- (schema-only mode) — run with the knowledge base to get cited risks`);
  }

  parts.push(`## Inter-process impact`);
  parts.push(`- If ${name} triggers another process, add a forward in src/auth_gateway/forward.c (reconnect-on-next-send) and assert the DOWNSTREAM effect in a suite, not just the local ack.`);

  parts.push(`## Suggested test suites`);
  parts.push(
    JSON.stringify(
      {
        name: "proposed-suite",
        description: `proposed coverage for: ${ctx.request}`,
        steps: [
          {
            id: "trigger",
            send: { to: "pay-orders", msg: "CreatePayment", fields: { txn_id: 9901, account: "ACCT-001", amount_cents: 1000, currency: "USD" } },
            expectAck: { status: 0 },
          },
          { id: "wait-forward", delayMs: 500 },
          { id: "assert-downstream", dbAssert: { sql: "SELECT status FROM payments WHERE txn_id = ?", params: [9901], expect: { status: "open" } } },
        ],
      },
      null,
      2,
    ),
  );

  return parts.join("\n\n") + "\n";
}

export function writeDesign(ctx: DesignContext, generatedAt: string): string {
  const mode = ctx.withKb ? "kb" : "no-kb";
  const file = path.join(DESIGNS_DIR(), `${slugify(ctx.request)}-${generatedAt.slice(0, 10)}-${mode}.md`);
  fs.mkdirSync(DESIGNS_DIR(), { recursive: true });
  fs.writeFileSync(file, renderDesign(ctx, generatedAt));
  return file;
}

/** Optional LLM rewrite of the deterministic draft (KB_API_KEY required). */
export async function llmRewrite(ctx: DesignContext, draft: string): Promise<string> {
  const key = process.env.KB_API_KEY;
  if (!key) throw new Error("KB_API_KEY is not set");
  const provider = process.env.KB_PROVIDER ?? "openai";
  const model = process.env.KB_MODEL ?? "gpt-4o-mini";
  const baseUrl = (process.env.KB_BASE_URL ?? `https://api.${provider}.com/v1`).replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content:
            "You are the designer agent. Refine this PROPOSED design doc. Keep the exact '## ' section order. " +
            "Cite knowledge/ paths for every claim. Never invent messages or files. Return only markdown.\n\n" + draft,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`designer LLM call failed: ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content?.trimEnd() + "\n";
}
