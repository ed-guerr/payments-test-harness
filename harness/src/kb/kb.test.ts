/**
 * kb/kb.test.ts — the retrieval that the KB-sensitive eval task depends on
 * (the agent must find the auth-gateway forward behavior). Pin it: if this
 * test is green, `kb_search` can still find the row the eval needs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, kbSearch, kbRead } from "./index";

// These tests exercise the KB-grounded surface; make sure the A/B flag
// (used by `npm run test:mcp`) is not leaking in from the environment.
delete process.env.MCP_NO_KB;

test("tokenize: lowercases, splits, drops stopwords", () => {
  const t = tokenize("The Payment Authorization Completes the payment!");
  assert.ok(t.includes("payment"));
  assert.ok(t.includes("authorization"));
  assert.ok(t.includes("completes"));
  assert.ok(!t.includes("the"), `"the" should be a stopword`);
});

test("kbSearch: the KB-sensitive query lands on the auth-gateway guide", () => {
  const hits = kbSearch("external authorization completes payment downstream side effect", 3);
  assert.ok(hits.length > 0, "expected at least one hit");
  const top = hits[0];
  assert.ok(
    top !== undefined && top.path.includes("auth_gateway"),
    `top hit was ${top?.path} :: ${top?.section}`,
  );
});

test("kbRead: full guide and a single section", () => {
  const md = kbRead("backend/auth_gateway.md");
  assert.match(md, /Authorize/);
  const sec = kbRead("backend/auth_gateway.md", "Messages");
  assert.ok(sec.startsWith("## Messages"));
  assert.match(sec, /Authorize/);
});

test("kbRead: refuses paths outside knowledge/ (traversal)", () => {
  assert.throws(() => kbRead("../../backend/db/schema.sql"), /escapes knowledge/);
});
