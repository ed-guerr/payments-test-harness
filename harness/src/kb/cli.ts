/**
 * kb/cli.ts — kb-forge command line.
 *
 *   npm run kb              regenerate all guides (+ INDEX.md + manifest)
 *   npm run kb:check        exit 1 listing guides whose sources changed
 *   npm run kb:write -- <dir>   regenerate one guide (e.g. backend/src/ledger)
 *   npm run kb:search -- "query"   dry-run the deterministic search
 */
import { checkStale, forgeAll } from "./forge";
import { META } from "./meta";
import { kbSearch } from "./index";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const llm = process.env.KB_API_KEY !== undefined && process.argv.includes("--llm");

  switch (cmd) {
    case "write": {
      const dir = rest[0];
      const meta = META.find((m) => m.dir === dir);
      if (!meta) {
        console.error(`unknown directory "${dir}". Known: ${META.map((m) => m.dir).join(", ")}`);
        process.exit(1);
      }
      const { forgeOne } = await import("./forge");
      const out = await forgeOne(meta, llm);
      console.log(`wrote ${out.path} (${out.bytes} bytes)`);
      return;
    }
    case "check": {
      const stale = checkStale();
      if (stale.length === 0) {
        console.log("knowledge/ is up to date");
        return;
      }
      console.error("stale guides (run `npm run kb`):");
      for (const s of stale) console.error(`  ${s.guide}  (source ${s.sourceDir}: ${s.expected} -> ${s.actual})`);
      process.exit(1);
      return;
    }
    case "search": {
      const query = rest.join(" ");
      if (!query) {
        console.error("usage: npm run kb:search -- \"query\"");
        process.exit(1);
      }
      for (const hit of kbSearch(query)) {
        console.log(`[${hit.score}] ${hit.path} :: ${hit.section}`);
      }
      return;
    }
    default: {
      const result = await forgeAll({ llm });
      console.log(`kb-forge: wrote ${result.guides.length} guides`);
      for (const g of result.guides) console.log(`  ${g.path} (${g.bytes} bytes)`);
      console.log(llm ? "mode: llm-enhanced" : "mode: deterministic (set KB_API_KEY and pass --llm for LLM-enhanced)");
      return;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
