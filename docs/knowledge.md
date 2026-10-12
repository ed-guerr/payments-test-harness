# Knowledge pipeline (kb-forge)

The knowledge layer closes the loop between *structure* (the registry says
which fields exist) and *meaning* (what a message **does**: preconditions,
side effects, which process it drives). A codebase-walking agent — **kb-forge**
— writes one markdown **intern guide** per source directory into `knowledge/`;
two consumers build on that corpus: the MCP test author and the designer.

## What gets generated

```
knowledge/
├── INDEX.md              # one-line purpose per guide
├── .manifest.json        # {path, sourceDir, sourceHash, generatedAt} per guide
├── backend/
│   ├── README.md         # index of the backend guides
│   ├── common.md         # wire codec, dispatch table, introspection, sockets
│   ├── pay_orders.md     # payment lifecycle owner (:9101)
│   ├── ledger.md         # double-entry ledger (:9102)
│   └── auth_gateway.md   # external auth/settle boundary (:9103) + forwarding
└── harness/
    ├── README.md
    ├── protocol.md       # registry + codec + framed TCP client
    ├── runner.md         # the suite execution engine
    ├── main.md           # Electron main + IPC + self-test mode
    ├── mcp.md            # the MCP server
    └── renderer.md       # the React UI
```

Every guide uses the **same section schema** (so retrieval is deterministic):

```
## Purpose
## Files                 table: file | ~lines
## Domain vocabulary     table: business term → message/function
## Messages              (backend dirs) message | dir | precondition | side effect
## Key functions         table: function (file:line) | what it does
## Common modification points
## Risks                 table: area | risk | mitigation
## Inter-process interactions
```

Example row (from `knowledge/backend/auth_gateway.md`, generated):

```
| `Authorize` (40) | in | payments row exists, status open
  | on approve -> forwards CompletePayment to pay-orders:9101 (fire-and-forget) |
```

That row is exactly what lets an agent write a test that asserts the payment
reaches `complete` after an authorization — a side effect invisible in the
wire schema alone.

## The generator

`kb-forge` has two modes:

| Mode | How | Needs |
|---|---|---|
| **deterministic** (default) | mechanical extraction (file listing, C function signatures with `file:line`, message tables from the registry, TODO/FIXME) + the curated facts in `harness/src/kb/meta.ts` | nothing — runs offline |
| **LLM-enhanced** | the assembled context + curated facts are sent to an OpenAI-compatible endpoint under a strict "cite `file:line`, never invent" prompt; the response replaces the prose | `KB_API_KEY` (+ `KB_PROVIDER`/`KB_MODEL`/`KB_BASE_URL`) |

Guides are **generated, then committed** (same pattern as the registry): the
committed files keep the repo fully usable offline; the generator reproduces
them when code changes.

| Command | Action |
|---|---|
| `npm run kb` | regenerate all guides + `INDEX.md` + manifest |
| `npm run kb -- --llm` | regenerate with LLM-enhanced prose (needs `KB_API_KEY`) |
| `npm run kb:check` | rehash sources vs manifest; exit 1 listing stale guides |
| `npm run kb:write -- <dir>` | regenerate one guide (e.g. `backend/src/ledger`) |
| `npm run kb:search -- "query"` | dry-run the retrieval |

`npm run kb:check` is a **merge gate**: after any change under `backend/` or
`harness/src/` the sources' hash changes, and a stale guide is a bug
(see `docs/conventions/conventions.md` §4/§6).

## Retrieval — deterministic, no vector DB

`kb_search(query)` over ~15 small guides:

1. Tokenize (lowercase, split on non-alphanumeric, drop stopwords).
2. Split each guide into sections at `## ` headings.
3. Score: **3×** per distinct query term in the heading, **2×** per term in
   table rows (Messages / Domain vocabulary / Risks / Files), **1×** per term
   in body.
4. Return top N (default 5) as `{path, section, score, excerpt}`.

Why not embeddings: the corpus is small and section-schema'd; term scoring is
explainable, unit-testable, and never flaky — which matters when the output is
agent-authored artifacts.

## Consumers

**The MCP test author** (`docs/mcp.md`): `kb_search` + `kb_read` tools;
`get_message_schema` appends the KB row for the message as `notes`;
`create_suite` failures carry `kbHints`. `MCP_NO_KB=1` disables all of it for
the A/B demo.

**The designer** (`npm run design -- "<change request>"`): searches the KB,
loads the affected guides + registry, and writes a reviewable design doc to
`docs/designs/<slug>-<date>.md` (X-macro proposal, handler sketch, risks
citing `knowledge/` paths, suggested suite JSON). The designer **proposes**,
it never applies. The same A/B applies: `MCP_NO_KB=1 npm run design …`
produces a schema-only doc to contrast against the grounded one (sample pairs
are committed under `docs/designs/`).
