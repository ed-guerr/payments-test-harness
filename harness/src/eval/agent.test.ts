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

test("Agent retries fetch-level stalls and recovers", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    attempts++;
    if (attempts < 3) throw new TypeError("fetch failed");
    assert.ok(init?.signal instanceof AbortSignal, "request must carry an explicit timeout");
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
      chatTimeoutMs: 60000,
      chatRetries: 2,
    }, mockMcp(), { kbAblation: "enabled" });
    await agent.discoverTools();
    const result = await agent.run("system", "user");
    assert.equal(result.error, null);
    assert.equal(result.finalText, "DONE");
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Agent surfaces a descriptive error when chat retries are exhausted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const agent = new Agent({
      apiBase: "http://localhost/v1",
      model: "test-model",
      apiKey: "",
      temperature: 0,
      maxToolSteps: 3,
      chatTimeoutMs: 60000,
      chatRetries: 1,
    }, mockMcp(), { kbAblation: "enabled" });
    await agent.discoverTools();
    const result = await agent.run("system", "user");
    assert.match(result.error ?? "", /chat request failed after 2 attempt\(s\) at 60000 ms each/);
    assert.match(result.error ?? "", /fetch failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
