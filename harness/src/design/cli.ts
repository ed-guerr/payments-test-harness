/**
 * design/cli.ts — the designer entry point.
 *
 *   npm run design -- "<plain-English change request>"
 *   MCP_NO_KB=1 npm run design -- "<plain-English change request>"   (A/B)
 *   KB_API_KEY=... npm run design -- --llm "<request>"               (LLM rewrite)
 *
 * Writes docs/designs/<slug>-<date>.md. The designer PROPOSES, it never
 * applies: the doc is a reviewable artifact.
 */
import fs from "node:fs";
import { gatherContext, llmRewrite, renderDesign, writeDesign } from "./designer";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useLlm = args.includes("--llm");
  const request = args.filter((a) => a !== "--llm").join(" ").trim();
  if (!request) {
    console.error('usage: npm run design -- "<plain-English change request>" [--llm]');
    process.exit(1);
  }
  const ctx = gatherContext(request);
  const generatedAt = new Date().toISOString();
  const mode = ctx.withKb ? "KB-grounded" : "schema-only (MCP_NO_KB=1)";
  console.log(`designer: ${mode} · ${ctx.kbHits.length} KB sections used`);
  let file = writeDesign(ctx, generatedAt);
  if (useLlm) {
    const draft = renderDesign(ctx, generatedAt);
    const refined = await llmRewrite(ctx, draft);
    fs.writeFileSync(file, refined);
    console.log("designer: LLM rewrite applied");
  }
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
