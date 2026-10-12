# harness/src/protocol — Intern Guide

> generated 2026-10-12T22:20:15.356Z · kb-forge 0.1 · source sha256:bd1c5fa77085

## Purpose

Wire protocol layer in TypeScript. registry.json (generated from the C binaries' --introspect) is the single source of truth; codec.ts packs/unpacks messages at the exact packed offsets; conn.ts is the framed TCP client (8-byte header accumulation, deadline-aware recv).

## Files

| file | ~lines |
|---|---|
| codec.ts | 133 |
| conn.ts | 108 |
| registry.json | 366 |
| types.ts | 51 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `registry` | registry.json — processes, messages, fields, packed offsets |
| `frame` | 8-byte LE header (magic 0x5046, msg_id, payload_len) + payload |
| `conn` | Conn class — send(msgId, payload) / recv(msgId, deadline) / close() |

## Key functions

_no top-level C function definitions in this directory_

## Common modification points

- Protocol changes happen in C first; then npm run gen:registry; the codec needs no edits (offset-driven).

## Risks

| area | risk | mitigation |
|---|---|---|
| codec.ts | registry drift (C changed, registry stale) -> silent mis-decode | field offsets come from sizeof/offsetof in C, never re-derived here |
| conn.ts | partial TCP frames | buffer accumulation loop in _read |

## Inter-process interactions

- Feeds the runner, the MCP schemas, and the GUI registry viewer.
