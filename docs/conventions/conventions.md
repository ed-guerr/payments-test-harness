# Project Conventions

These rules apply to **every human developer and every coding agent** that touches
this repository — no exceptions, no prompting. If a rule conflicts with "it
works," the rule wins: fix the rule by discussion (a PR to this file), never by
silently breaking it.

Coding agents: run the gates in §4 **yourself** before proposing a commit, and
format the commit yourself. If a gate fails, fix the code — do not lower the
gate.

---

## 1. Git & commits

### 1.1 Conventional Commits (1.0.0) — scope required

Every commit message must match:

```
type(scope): subject
[blank line]
body (optional)
[blank line]
footer (optional: BREAKING CHANGE: …, refs)
```

**Allowed types**

| type | use for |
|---|---|
| `feat` | a new message, handler, process, screen, step type, or tool |
| `fix` | a bug fix (behavior change that repairs a defect) |
| `docs` | documentation only (including KB guides and design docs) |
| `style` | formatting/whitespace only — no behavior change |
| `refactor` | restructuring without behavior change |
| `perf` | performance improvement |
| `test` | test suites, smoke tests, fixtures |
| `build` | build system (Makefile, package.json deps, electron config) |
| `ci` | CI/CD config |
| `chore` | maintenance that fits nowhere else |
| `revert` | reverting a previous commit |

**Allowed scopes** (one of these on **every** commit):

`backend` (C common code) · `pay-orders` · `ledger` · `auth-gateway` ·
`harness` (app shell/IPC) · `ui` (renderer) · `runner` · `mcp` · `kb` ·
`design` · `docs` · `tooling` (smoke test, introspect script) · `infra`
(repo-level: .gitignore, LICENSE, CI) · `eval` · `artifacts` · `suites` ·
`docker` · `readme`

**Subject line rules**

- Imperative mood: `add`, not `added` / `adds`
- Max 72 characters for the whole subject line
- No trailing period
- Lowercase first character (except proper nouns)

**Body rules** — explain **why** and any non-obvious consequence; the diff
already shows *what*. Wrap at 72 columns.

**Breaking changes** — append `!` before the colon
(`feat(ledger)!: change TransferAck status codes`) and add a
`BREAKING CHANGE:` footer explaining the impact.

**One logical change per commit.** Never combine a feature with a fix, a
refactor with a feature, or code with unrelated docs.

Good:

```
feat(ledger): add ReverseTransfer handler

Reverses an applied ledger entry and restores both balances. Needed so the
cancel flow can unwind a transfer without touching payment status.

BREAKING CHANGE: none
```

```
fix(auth-gateway): cap reconnect backoff at 2000ms
```

```
docs(protocol): document ErrorAck codes
```

Bad:

```
fixed stuff                          ← no type/scope, past tense
feat: added ledger and also logging  ← two changes, no scope
WIP: ledger                          ← not conventional, not done
```

### 1.2 Workflow

- Branch names: `<type>/<kebab-slug>` — e.g. `feat/refund-message`,
  `fix/ack-timeout`.
- **Rebase** onto `main` before finishing; no merge commits on branches.
- **Never force-push** a branch after it has been shared.
- `main` is always green: `make` + `make check` + `npm run check` +
  `npm run run:cli -- payment-happy-path --reset` all pass.
- The commit log is part of the project's story — keep it atomic and honest;
  do not squash history.

---

## 2. C standards (`backend/`)

### 2.1 Language & build

- **C11**, clang or gcc.
- Compile flags: `-std=c11 -Wall -Wextra -Werror -O2`.
  **Zero warnings is a merge gate.** No `-w`, no `#pragma` suppressions
  (a `clang-diagnostic` pragma requires a comment justifying it).
- `make check` builds with `-fsanitize=address,undefined` and runs the smoke
  test against it. **Any commit touching C code must pass `make check`.**
- Dependencies: libc + libsqlite3 only. No new libraries without a design doc.

### 2.2 Formatting — Allman, braces on their own line

Every opening brace — functions, control statements, structs, enums,
initializer lists — goes on its **own line**:

```c
int handle_create_payment(const Envelope *env, int fd)
{
    const CreatePaymentMsg *msg = (const CreatePaymentMsg *)env->payload;
    PaymentAckMsg ack;

    ack.txn_id = msg->txn_id;

    if (db_account_exists(msg->account) != 0)
    {
        ack.status = ACK_ACCOUNT_NOT_FOUND;
        return send_msg(fd, MSG_PAYMENT_ACK, &ack, sizeof(ack));
    }

    if (db_payment_create(msg->txn_id, msg->account, msg->amount_cents,
                          msg->currency) != 0)
    {
        ack.status = ACK_INVALID;
        return send_msg(fd, MSG_PAYMENT_ACK, &ack, sizeof(ack));
    }

    ack.status = ACK_OK;
    return send_msg(fd, MSG_PAYMENT_ACK, &ack, sizeof(ack));
}
```

- Indent: **4 spaces**, never tabs.
- Line width: **100** characters (soft for long string literals).
- One statement per line.
- Spaces around binary operators; no space after a cast
  (`(const uint8_t *)buf`); no space inside parens.
- Blank line between logical blocks inside a function.
- X-macro field lists: keep the `F(name, type)` columns aligned; clang-format
  must not reflow backslash continuations — review its diff on those blocks.

Style is machine-checked: `make fmt` (write) and `make fmt-check` (verify)
use `.clang-format` (Allman profile). Staged C files must pass `fmt-check`.

### 2.3 Naming

| Entity | Convention | Example |
|---|---|---|
| Files | `snake_case.c` / `.h` | `envelope.c`, `message.h` |
| Functions | `snake_case`, domain prefix | `env_decode`, `sock_accept_loop`, `db_payment_create`, `handle_create_payment` |
| Struct/union types | `UpperCamelCase` | `CreatePaymentMsg`, `FieldDef` |
| `typedef`s | lowercase + `_t` | `msg_handler_t`, `conn_t` |
| Constants & macros | `UPPER_SNAKE`, domain prefix | `MSG_PAYMENT_ACK`, `PF_MAGIC`, `ERR_SIZE_MISMATCH`, `MAX_PAYLOAD` |
| Local variables | `snake_case` | `payload_len`, `client_fd` |
| Booleans/flags | `is_` / `has_` / `should_` prefix | `is_running` |
| Binaries | `kebab-case` | `pay-orders`, `auth-gateway` |

Prefixes are mandatory for anything that could collide: `MSG_` (message ids),
`ACK_` (ack status codes), `ERR_` (error codes), `PF_` (protocol/field macros).

### 2.4 Headers & includes

- `#pragma once` on every header.
- Include **what you use and nothing you don't**.
- Order: own header → system headers → project headers (`pay/…`).
- No include cycles. A header that needs a type it doesn't declare owns that
  type; it does not pull in other headers to sneak it in.

### 2.5 Correctness — non-negotiable

**Check every return value that can fail.** `malloc`, `open`, `connect`,
`send`, `recv`, `sqlite3_*`, and every project function that returns a status.
An ignored return value is a bug, full stop.

**No memory leaks — ownership is explicit.**

- Every allocation has exactly **one owner**, stated at the allocation site
  in a comment if non-obvious, and freed on **every** path including errors.
- Prefer stack and static buffers in the message path; the protocol is
  fixed-size by design — per-message heap growth is a design smell.
- `make check` (ASan/UBSan) is the enforcement mechanism. A leak found by
  anyone, any time, is fixed before the next commit lands.

**No unbounded string functions.** Banned: `strcpy`, `strcat`, `sprintf`,
`gets`, `scanf`-style into fixed buffers. Allowed: `snprintf` (size always
explicit), `memcpy`/`memmove` (bounds explicit), `strcmp`/`strncmp`/`strlen`
on known-terminated data. Protocol `char[N]` fields are treated as
byte buffers — NUL-trim on decode, NUL-pad on encode.

**No implicit narrowing or truncation.** Protocol integers use exact-width
types (`uint8_t` … `uint32_t`, `int32_t`). A narrowing cast is only allowed
with an explicit comment proving the range.

**No global mutable state.** Message tables are `static const`. Configuration
(`--db`, `--port`) is parsed once at startup into a `static const` context or
passed explicitly.

**No `goto`.** Handlers are small by design; structure with early returns.

**No undefined behavior.** No signed overflow, no out-of-bounds access, no
use-after-free, no reading uninitialized data. The ASan/UBSan gate exists for
this reason.

**No `assert()` in production paths.** Runtime checks log, report, and return
an error code. `assert` may only appear in `--introspect`/self-test code.

**Single-threaded.** Each process is one thread with a `select()` loop. No
locks, no atomics. Adding threading is a design-doc decision, not an
implementation detail.

### 2.6 Efficiency — no waste, no premature optimization

- **No busy-waits or `sleep()` polling** in protocol code. Block on
  `select()` with explicit timeouts.
- **No redundant copies.** Pass large buffers as `const` pointers; serialize
  directly from the struct. `sizeof(struct)` copies are fine; buffer copies
  need a reason.
- **One shared SQLite handle** per process, opened once. Transactions are
  short and explicit.
- Message tables are small (≤ 10 entries): linear lookup is fine and
  documented. O(n²) in frame processing or handler code is not acceptable.
- No premature optimization — but no gratuitous work either: don't decode a
  payload you won't use, don't log inside loops beyond the per-message line.

### 2.7 Code smells — banned

| Smell | Rule |
|---|---|
| Dead code / commented-out code | Delete it. Git remembers. |
| Unused variables/parameters | Remove them; for interface-required params use the name `_unused` |
| Magic numbers | Named constant (`ACK_OK`, not `0`) |
| Duplicated logic | Move to `src/common/` |
| `TODO` / `FIXME` | Only with owner + reason; **zero** on shipped features |
| Function doing two unrelated things | Split it |
| Swallowed errors (empty error branch) | Log + propagate or handle — never `{}` |
| Nesting deeper than 3 levels | Early returns |
| Function longer than ~50 lines | Split it |

### 2.8 SQL (C side)

- Parameterized statements only: `sqlite3_prepare_v2` + binds. No string-built
  SQL, ever.
- Short transactions; commit promptly; roll back on every error path.

### 2.9 Comments

- Explain **why** (protocol constraints, edge cases, invariants) — the code
  shows *what*.
- Every message-table entry gets a one-line comment stating its side effect
  (e.g. `/* on approve: forwards CompletePayment to pay-orders */`).
- No commented-out code. No obvious comments (`i++; // increment i`).

---

## 3. TypeScript standards (`harness/`)

- `tsconfig` **strict** mode. `any` is banned — use `unknown` and narrow.
- **zod at every boundary**: IPC payloads, MCP tool inputs/outputs, file
  reads (suites, registry, runs). A value that crosses a boundary is parsed,
  not trusted.
- ESM only; **named exports** (default export is allowed only for page
  components).
- No `console.*` in the main process — use the shared `log()` helper with a
  process tag. No `eval`.
- **Electron-free core:** `runner`, `backend-manager`, `db`, `registry`,
  `kb`, `design`, and everything in `src/shared` must not import `electron`.
  They run headless (CLI, CI) — the UI is a client, not a dependency.
- Adding a step type or message type is a checklist in **one commit**:
  `shared/types` + `shared/schemas` (zod) + runner handling + UI form +
  MCP tool docs.

**Prettier** (`.prettierrc`): 2-space indent, semicolons, single quotes,
print width 100, trailing commas. Staged TS/JSON/MD files must pass
`prettier --check`.

---

## 4. Verification gates (merge checklist)

Run these **locally, before committing** — a red gate on review is a review
failure.

| Change touches | Required gates |
|---|---|
| Any C code | `make` (zero warnings, `-Werror`) · `make check` (ASan+UBSan + smoke test) · `make fmt-check` |
| Makefile / build | `make` + `make check` |
| Harness TS | `npm run typecheck` clean |
| Runner or suite format | `npm run run:cli -- suites/payment-happy-path.json` green |
| Protocol / messages | `npm run gen:registry` → `harness/src/protocol/registry.json` diff is intended (same commit) · `npm run kb` (guides embed message tables) · `npm run kb:check` |
| KB sources (meta.ts) or guides | `npm run kb` + `npm run kb:check` |
| MCP server | `npm run test:mcp` (and `MCP_NO_KB=1 npm run test:mcp` for the A/B path) |
| Electron main / preload | `HARNESS_SELF_TEST=1 npm start` exits 0 |
| Every commit | Conventional format with scope (§1.1) · subject ≤ 72 chars |

`make check` is the leak/UB gate for C; `npm run run:cli …` is the
behavioral gate for the harness; `npm run kb:check` is the staleness gate
for the knowledge base. None is optional.

---

## 5. Mechanical enforcement

Machine-checkable rules are machine-checked — a style or format failure is not
a judgment call.

| Tool | Covers | Config |
|---|---|---|
| `.clang-format` (Allman profile) | C formatting (§2.2) | `make fmt` / `make fmt-check` |
| Prettier | TS/JSON/MD formatting (§3) | `npm run check` |
| `commitlint` | Conventional Commits + scope enum (§1.1) | husky `commit-msg` hook |
| husky `pre-commit` | `clang-format --dry-run` on staged C files, `prettierr --check` on staged TS/JSON/MD | — |

Setup: `.clang-format` lands with the backend (P1); `.prettierrc`, husky, and
commitlint land with the harness scaffold (P2.1).

---

## 6. Documentation sync

- **Protocol change** (new message, field, ack code) → regenerate the
  registry **in the same commit**: `npm run gen:registry` rewrites
  `harness/src/protocol/registry.json` from the binaries' `--introspect`.
  The plan's message catalog tables are documentation; the registry is
  ground truth.
- **Behavior change** (side effects, preconditions, forwards) → update the
  curated facts in `harness/src/kb/meta.ts` and run `npm run kb` in the same
  change. Stale KB is a bug: `npm run kb:check` must pass on `main`.
  (`npm run kb` is deterministic without an API key; `--llm` with
  KB_API_KEY rewrites the prose.)
- **README quickstart** — every command must be verbatim-runnable from a
  fresh clone (verified in the final docs phase).
- Docs live in `docs/`; the README links to them instead of duplicating.

---

## 7. Security

- **Localhost only.** The three backend processes bind `127.0.0.1` exclusively;
  there is no network surface beyond ports 9101–9103 on loopback.
- **No secrets in the repo.** API keys and provider credentials come from the
  environment (`KB_PROVIDER`, `KB_MODEL`, `KB_BASE_URL`, provider key env
  vars). Anything that looks like a credential fails review.
- **Parameterized SQL everywhere** — C (`sqlite3_prepare_v2` + binds, §2.8)
  and Node (better-sqlite3 `?` placeholders). No string-built SQL.
- **Validate-step SQL guard** stays enforced: `SELECT`/`WITH` only, single
  statement, read-only DB handle.
- **Logging:** log structured facts (ids, sizes, status codes) — never raw
  client payload bytes, and never unbounded data interpolated into a line.

---

## How to change these conventions

Open a PR to this file, explain the why, and land it **before** the first
commit that relies on the new rule. Conventions are code: they get review,
commits (`docs:` type), and gates.
