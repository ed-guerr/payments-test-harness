# payments-test-harness — headless image (roadmap R9)
#
# What is in the image: the three C backend binaries, the harness's
# electron-free paths (run:cli, mcp, eval, eval:replay, kb:check), the
# committed generated artifacts (registry.json, knowledge/), and the
# committed suites. The container is a disposable tool: one run = one
# fresh cluster + one fresh database, exactly like the host runs.
#
# What is deliberately NOT in the image: the Electron GUI (`npm run
# start` / e2e) — it is a demo surface, not the product. ELECTRON_SKIP_
# BINARY_DOWNLOAD keeps its ~100 MB binary out of node_modules.
#
# The MCP server runs over stdio inside the container; the backend
# cluster binds 127.0.0.1 inside the container's network namespace, so
# nothing is exposed to the host by design.

# ── stage 1: build ────────────────────────────────────────────────────────
FROM node:24-bookworm AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential make libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/ backend/
RUN make -C backend

COPY harness/ harness/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm --prefix harness ci

# The registry is generated from the C function-pointer tables; fail the
# build if the committed registry.json is stale relative to this C code.
RUN cp harness/src/protocol/registry.json /tmp/registry.committed.json \
    && npm --prefix harness run gen:registry \
    && diff -u /tmp/registry.committed.json harness/src/protocol/registry.json \
    && echo "registry is current"

# ── stage 2: runtime ──────────────────────────────────────────────────────
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/backend/build/ backend/build/
COPY backend/db/ backend/db/
COPY --from=build /app/harness/node_modules/ harness/node_modules/
COPY harness/ harness/
COPY knowledge/ knowledge/

# The harness mirrors the repo layout (harness/../backend/build, etc.);
# docs/test-runs/ is where HTML run reports are written.
RUN mkdir -p docs/test-runs

ENTRYPOINT ["npm", "--prefix", "harness", "run"]
CMD ["run:cli", "--", "suites/payment-happy-path.json"]
