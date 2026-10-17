import { test } from "node:test";
import assert from "node:assert/strict";
import { THREE_WAY_ABLATION } from "./ablation";

/** Minimal OpenAI-style tool spec used to exercise the ablation logic. */
interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

const KB_TOOL_NAMES = new Set(["kb_search", "kb_read"]);

/** Remove KB content while preserving the exact callable tool surface. */
function toolsWithoutKnowledge(tools: ToolSpec[]): ToolSpec[] {
  return tools.map((tool) => {
    if (!KB_TOOL_NAMES.has(tool.function.name)) return structuredClone(tool);
    return {
      ...structuredClone(tool),
      function: {
        ...structuredClone(tool.function),
        description: "Knowledge retrieval tool disabled for this experiment condition.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    };
  });
}

test("three-way experiment includes content-only ablation between full KB and no KB", () => {
  assert.deepEqual(THREE_WAY_ABLATION, ["kb-on", "kb-content-off", "kb-off"]);
});

test("knowledge ablation keeps the tool names and count fixed", () => {
  const original: ToolSpec[] = [
    { type: "function", function: { name: "list_messages", description: "List", parameters: { type: "object" } } },
    { type: "function", function: { name: "kb_search", description: "Search docs", parameters: { type: "object", properties: { query: { type: "string" } } } } },
    { type: "function", function: { name: "kb_read", description: "Read docs", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ];
  const ablated = toolsWithoutKnowledge(original);
  assert.deepEqual(ablated.map((t) => t.function.name), original.map((t) => t.function.name));
  assert.equal(ablated.length, original.length);
  assert.deepEqual(ablated[0], original[0]);
  assert.match(ablated[1]?.function.description ?? "", /disabled/);
  assert.deepEqual(ablated[1]?.function.parameters, { type: "object", properties: {}, additionalProperties: false });
});
