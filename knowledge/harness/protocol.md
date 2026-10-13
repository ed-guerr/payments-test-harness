# harness/src/protocol — Intern Guide

> written by Qwen3 (local, via pi coding agent) · generated 2026-10-13T02:23:53.431Z · kb-forge 0.2 · source sha256:356e651504a7

## Purpose

Wire protocol layer in TypeScript. registry.json (generated from the C binaries' --introspect) is the single source of truth; codec.ts packs/unpacks messages at the exact packed offsets; conn.ts is the framed TCP client (8-byte header accumulation, deadline-aware recv).

## Files

| file | ~lines |
|---|---|
| codec.ts | 133 |
| conn.ts | 108 |
| registry.json | 365 |
| types.ts | 50 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `registry` | registry.json — processes, messages, fields, packed offsets |
| `frame` | 8-byte LE header (magic 0x5046, msg_id, payload_len) + payload |
| `conn` | Conn class — send(msgId, payload) / recv(msgId, deadline) / close() |

## Key functions

| function | defined at |
|---|---|
| `listProcs` | codec.ts:16 |
| `getProc(proc: string)` | codec.ts:20 |
| `findMessage(proc: string, name: string)` | codec.ts:32 |
| `messageSize(proc: string, name: string)` | codec.ts:39 |
| `pack(proc: string, name: string, fields: Record<string, FieldValue>)` | codec.ts:43 |
| `unpack(proc: string, name: string, payload: Buffer)` | codec.ts:54 |
| `writeField(buf: Buffer, f: FieldDef, v: FieldValue)` | codec.ts:66 |
| `readField(buf: Buffer, f: FieldDef)` | codec.ts:95 |
| `frameHeader(msgId: number, payloadLen: number)` | codec.ts:116 |
| `parseHeader(hdr: Buffer)` | codec.ts:125 |
| `Conn` | conn.ts:20 |

## Common modification points

- Protocol changes happen in C first; then npm run gen:registry; the codec needs no edits (offset-driven).

## Risks

| area | risk | mitigation |
|---|---|---|
| codec.ts | registry drift (C changed, registry stale) -> silent mis-decode | field offsets come from sizeof/offsetof in C, never re-derived here |
| conn.ts | partial TCP frames | buffer accumulation loop in _read |

## Inter-process interactions

- Feeds the runner, the MCP schemas, and the GUI registry viewer.
