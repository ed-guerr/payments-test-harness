import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent";

function mockMcp() {
  return {
    listTools: async () => ({ tools: [
      { name: "list_messages", description: "List messages", inputSchema: { type: "object", properties: {} } },
      { name: "kb_search", description: "Search knowledge", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "kb_read", description: "Read knowledge", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ] }),
    callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
  } as never;
}

test("Agent sends the seed and preserves KB tool names while suppressing content", async () => {
  const originalFetch = globalThis.fetch;
  const posted: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "DONE" } }], usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const agent = new Agent({
      apiBase: "http://localhost/v1",
      model: "test-model",
      apiKey: "",
      temperature: 0,
      maxToolSteps: 3,
      seed: 1234,
    }, mockMcp(), { kbAblation: "content-only" });
    await agent.discoverTools();
    await agent.run("system", "user");
    const sentTools = posted[0]?.tools as { function: { name: string; description: string; parameters: unknown } }[] | undefined;
    assert.deepEqual(sentTools?.map((t) => t.function.name), ["list_messages", "kb_search", "kb_read"]);
    assert.match(sentTools?.[1]?.function.description ?? "", /disabled/);
    assert.deepEqual(sentTools?.[1]?.function.parameters, { type: "object", properties: {}, additionalProperties: false });
    assert.equal(posted[0]?.seed, 1234);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
