# Docker — headless image

The container is a **disposable tool**, not a service: one run = one fresh
backend cluster + one fresh database, exactly like a host run. The backend
cluster binds `127.0.0.1` *inside* the container's network namespace, so
nothing is exposed to the host by design — the MCP server speaks stdio,
which is the docker-native way.

## What's in the image

- The three C backend binaries (`backend/build/`), built in-image with
  gcc, `-O2 -Wall -Wextra -Werror` (the CI `docker` job is the repo's
  "C builds with gcc" proof — local dev uses Apple clang).
- The harness's electron-free paths: `run:cli`, `mcp`, `eval`,
  `eval:replay`, `kb:check`, `test:unit`.
- The committed generated artifacts (`registry.json`, `knowledge/`) and
  the committed suites — **no generation at runtime**. Introspection and
  KB forging happen on the author's machine at commit time, like the rest
  of the repo's flow. The build *does* diff a freshly regenerated
  `registry.json` against the committed one: a stale registry fails
  `docker build`.

## What's deliberately NOT in the image

The **Electron GUI** (`npm run start`, `test:e2e`) — it is a demo
surface, not the product. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` keeps the
~100 MB binary out of `node_modules`, which is most of the difference
between this image and a naive build.

## Build

```bash
docker build -t payments-harness .
```

## Run

```bash
# one suite, headless (this is the image's default command)
docker run --rm payments-harness run:cli -- suites/payment-happy-path.json

# the deterministic agent-surface gate, fully offline (~4 s)
docker run --rm payments-harness eval:replay

# the MCP server over stdio — the container IS the server process
docker run -i --rm payments-harness mcp
```

MCP client config (e.g. Claude Desktop) — use docker as the spawn command:

```json
{
  "mcpServers": {
    "payments-harness": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "payments-harness", "mcp"]
    }
  }
}
```

## Real-model eval in the container

The eval harness is in the image. Point it at a reachable model endpoint:

```bash
docker run --rm \
  -e EVAL_API_BASE=http://<your-lan-gpu-box>:8080/v1 \
  -e EVAL_API_MODEL=qwen3 \
  -e EVAL_API_KEY=<key> \
  payments-harness eval
```

LAN endpoints work directly; a model served **on the Docker host** is
reached via `http://host.docker.internal:8080/v1` (Docker Desktop) or
`--net host` (Linux).

## Artifacts

Per-suite databases (`harness/data/`), run results (`harness/runs/`), and
HTML reports (`docs/test-runs/`) live inside the container's filesystem
and die with it — matching the host semantics. Keep them out for
inspection with a volume:

```bash
docker run --rm -v "$PWD/.docker-artifacts:/app/harness" \
  payments-harness run:cli -- suites/payment-happy-path.json
```

## CI

The `docker` job in `.github/workflows/verify.yml` builds the image on a
Linux runner and proves it runs: the default command (one suite green)
plus `eval:replay` (the 4-trace gate) inside the image.
