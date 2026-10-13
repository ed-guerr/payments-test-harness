# Security model — keeping the LLM from doing harm

Status: current as of 2026-10-13 (roadmap M3). Companion doc:
[`agent.md`](agent.md) (why the surface is shaped this way).

The uncomfortable fact up front: **the agent writes raw SQL that executes
against the backend database, and can SIGKILL backend processes.** Those are
features (failure-mode tests need `expectError` + `dbAssert`; chaos tests
need `killProcess`). The design goal is not to make those capabilities
impossible — it is to make the *worst case harmless*, structurally, rather
than relying on the model behaving.

Guiding principle: **validate at authoring, contain at execution, and let
the blast radius do the rest.**

## 1. Threat table

| Threat | Surface | Mitigation (as-built) | Verified by |
|---|---|---|---|
| Agent-authored DDL/DML on the backend DB | `dbAssert.sql` executes at run time | Two layers: (1) `validateSuite` rejects anything that isn't a `SELECT`/`WITH` at authoring; (2) the runner executes dbAssert on a **read-only** connection — the driver itself refuses writes | `src/backend/suites.test.ts` (hostile cases), `src/db/db.test.ts` (driver refuses DDL/DML, seed intact) |
| Multi-statement SQL (`SELECT 1; DROP …`) | `dbAssert.sql` | Rejected at authoring (no semicolons allowed); even if one slipped through, the read-only connection refuses the write half | `suites.test.ts` `single statement` case; `db.test.ts` |
| Killing arbitrary processes | `killProcess` step | The step names a *registry process* (`pay-orders`/`ledger`/`auth-gateway`, validated) and a signal (`SIGKILL`/`SIGTERM` only); at runtime the kill targets the specific child PID **this cluster spawned** (`cluster.kill` → `child.kill`), never a pid the agent supplies. Blast radius: 3 disposable processes + 1 temp DB, and every run gets a fresh cluster anyway | `suites.test.ts` (unknown proc, bad signal), `src/backend/cluster.ts` |
| Path traversal via suite id | suite CRUD writes `harness/suites/<id>.json` | `safeSuiteFile` (`src/backend/paths.ts`): id must match `[a-z0-9-]` — no dots, no slashes, no hidden files. Single source of truth, shared by MCP server and CLI | `suites.test.ts` (6 hostile ids), replay trace `validation-errors-kb-on` call 2 |
| Invented protocol messages / fields | `send` step | Registry validation at `create_suite`/`update_suite` (unknown message, missing field, unknown process all rejected with structured errors + KB hints) | `suites.test.ts`, replay trace call 1 |
| Read path: agent exfiltrating data via `db_query` | MCP `db_query` | Restricted to `SELECT`/`WITH`, and only against `*.db` files inside the repo (server.ts); connections are `readOnly: true` (`src/db/db.ts`) | `src/mcp/kbTools.ts`/server.ts; behavior pinned by `mcp-self-test.js` |
| MCP server as an attack surface | any stdio client | The server is spawned locally over stdio (no network endpoint); every file it writes is inside the repo tree (`suites/`, `runs/`, `data/`); it holds no secrets (the only credential in the system, an API key, lives in env vars and never in the repo); protected suites can't be deleted (`PROTECTED` set, server.ts) | `src/mcp/server.ts`; replay traces exercise the CRUD surface |
| Network exposure | backend processes | Loopback-only bind: `127.0.0.1:9101-9103` (`backend/src/common/socket.c:186-194`); the harness TCP client and the UI connect to loopback; no other network surface exists | `socket.c`; README "The wire protocol" |
| Renderer/UI trust | Electron app | Sandboxed renderer, no Node access from the page; the preload bridge exposes only the suite/registry/db APIs (`src/main/`) | `src/main/preload.ts`, `src/renderer/` |

## 2. The three layers, in code

**Layer 1 — authoring (cheapest failure).** `validateSuite`
(`src/backend/suites.ts`) checks every step against the generated registry
and the step-kind grammar *before the suite file is written*. The error
text is steering-oriented (see agent.md §3). This is where most hostile or
clumsy input dies — with an explanation.

**Layer 2 — execution (contain what slips through).** The runner's dbAssert
path uses `assertDb()`, a lazily opened **read-only** `node:sqlite`
connection (`src/runner/runner.ts`, `src/db/db.ts` with
`{ readOnly: true }`). Suite SQL is agent-authored, so the assertion path is
structurally incapable of mutation regardless of what passed validation.
`killProcess` resolves to a spawned child handle — the agent can name a
process, but the *target* is fixed by the cluster.

**Layer 3 — blast radius (make the worst case cheap).** Every suite run
starts a **fresh cluster**: new DB file, three fresh processes
(`src/backend/cluster.ts`, `runSuiteByName` in server.ts). There is no
long-lived production database to damage; the seeded test data
(`backend/db/schema.sql`) is the only data there is, and it is reproducible
by re-opening the DB. The suite directory is the only writable surface, and
its names are charset-locked.

## 3. What is tested, and where

The hostile cases are not just documented — they are in the commit:

- `src/backend/suites.test.ts` — `hostile:` tests: DDL dbAssert,
  multi-statement dbAssert, path-traversal suite ids, unknown process,
  unknown message, two-kind step, bad signal.
- `src/db/db.test.ts` — driver-level: read-only connection refuses DDL and
  DML; seed rows intact afterwards.
- `src/eval/traces/validation-errors-kb-on.json` — the same hostile inputs
  replayed through the **live MCP server** on every push
  (`npm run eval:replay`, verify.sh step 8), including the exact error
  strings an agent would act on.
- `npm run verify` (8 steps) runs all of the above plus ASan/UBSan on the
  C side; `.github/workflows/verify.yml` runs it on every push/PR.

## 4. Residual risk (honest version)

- **Reading is by design.** An agent with MCP access can read every suite,
  the registry, the DB (read-only), and the KB. That is the job. The
  boundary is *write*, and write is: validated suite files inside
  `suites/`, run artifacts, and that's it.
- **The KB is a correctness surface, not a safety surface.** A wrong-but-
  fresh guide can lead the agent to author a *valid but wrong* suite — the
  suite will run, and the ground truth (or the human) catches it. Staleness
  is enforced mechanically (`kb:check` hashes); *incorrect curated facts*
  in `src/kb/meta.ts` are a human-review responsibility.
- **`killProcess` is real destructive capability**, scoped to 3 disposable
  processes of a cluster that is thrown away after every run. If the harness
  ever pointed at a shared/long-lived backend, this section would need to
  be redone before that.
- **New step kinds re-open this review.** The conventions
  (`docs/conventions/conventions.md`) require the threat table to be updated
  when a step kind or tool is added — the table above is only as good as
  that habit.
