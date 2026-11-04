/**
 * protocol/codec.ts — wire codec generated from the introspection registry.
 *
 * Pack/unpack are derived entirely from the field tables in registry.json:
 * each field is written at its absolute offset, char[N] fields are
 * NUL-padded fixed buffers. Nothing here hardcodes a message name or size —
 * a backend change + `npm run gen:registry` is all that is needed to
 * re-sync the harness.
 */
import registryJson from "./registry.json";
import { FRAME_HEADER, MAGIC } from "./types";
import type { FieldDef, FieldValue, MessageDef, Registry } from "./types";

const registry = registryJson as unknown as Registry;

export function listProcs(): string[] {
  return Object.keys(registry.procs);
}

export function getProc(proc: string): ProcDefLike {
  const p = registry.procs[proc];
  if (!p) throw new Error(`unknown process ${proc}`);
  return p;
}

interface ProcDefLike {
  process: string;
  listen: string;
  messages: MessageDef[];
}

export function findMessage(proc: string, name: string): MessageDef {
  const p = registry.procs[proc];
  const m = p?.messages.find((x) => x.name === name);
  if (!m) throw new Error(`unknown message ${proc}/${name}`);
  return m;
}

export function messageSize(proc: string, name: string): number {
  return findMessage(proc, name).size;
}

export function pack(proc: string, name: string, fields: Record<string, FieldValue>): Buffer {
  const m = findMessage(proc, name);
  const buf = Buffer.alloc(m.size);
  for (const f of m.fields) {
    const v = fields[f.name];
    if (v === undefined) throw new Error(`${name}: missing field ${f.name}`);
    writeField(buf, f, v);
  }
  return buf;
}

export function unpack(proc: string, name: string, payload: Buffer): Record<string, FieldValue> {
  const m = findMessage(proc, name);
  if (payload.length !== m.size) {
    throw new Error(`${name}: payload is ${payload.length} bytes, expected ${m.size}`);
  }
  const out: Record<string, FieldValue> = {};
  for (const f of m.fields) {
    out[f.name] = readField(payload, f);
  }
  return out;
}

function writeField(buf: Buffer, f: FieldDef, v: FieldValue): void {
  if (f.type.startsWith("char[")) {
    if (typeof v !== "string") throw new Error(`${f.name}: expected string, got ${typeof v}`);
    const b = Buffer.from(v, "utf8");
    // The protocol requires NUL-terminated string fields, so an exactly
    // full string (no room for the NUL) is a protocol violation.
    if (b.length >= f.size)
      throw new Error(`${f.name}: ${v} is ${b.length} bytes, field holds ${f.size - 1}`);
    b.copy(buf, f.offset); // remainder stays NUL
    return;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`${f.name}: expected integer, got ${v}`);
  }
  switch (f.type) {
    case "uint8_t":
      buf.writeUInt8(v, f.offset);
      break;
    case "uint16_t":
      buf.writeUInt16LE(v, f.offset);
      break;
    case "uint32_t":
      buf.writeUInt32LE(v, f.offset);
      break;
    case "int32_t":
      buf.writeInt32LE(v, f.offset);
      break;
    default:
      throw new Error(`${f.name}: unsupported type ${f.type}`);
  }
}

function readField(buf: Buffer, f: FieldDef): FieldValue {
  if (f.type.startsWith("char[")) {
    const raw = buf.subarray(f.offset, f.offset + f.size);
    const nul = raw.indexOf(0);
    return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
  }
  switch (f.type) {
    case "uint8_t":
      return buf.readUInt8(f.offset);
    case "uint16_t":
      return buf.readUInt16LE(f.offset);
    case "uint32_t":
      return buf.readUInt32LE(f.offset);
    case "int32_t":
      return buf.readInt32LE(f.offset);
    default:
      throw new Error(`${f.name}: unsupported type ${f.type}`);
  }
}

/** Build the 8-byte frame header (little-endian). */
export function frameHeader(msgId: number, payloadLen: number): Buffer {
  const hdr = Buffer.alloc(FRAME_HEADER);
  hdr.writeUInt16LE(MAGIC, 0);
  hdr.writeUInt16LE(msgId, 2);
  hdr.writeUInt32LE(payloadLen, 4);
  return hdr;
}

/** Validate a received header; throws on bad magic / oversized payload. */
export function parseHeader(hdr: Buffer): { msgId: number; payloadLen: number } {
  const magic = hdr.readUInt16LE(0);
  if (magic !== MAGIC) throw new Error(`bad magic 0x${magic.toString(16)}`);
  const msgId = hdr.readUInt16LE(2);
  const payloadLen = hdr.readUInt32LE(4);
  if (payloadLen > 2048) throw new Error(`payload too large: ${payloadLen}`);
  return { msgId, payloadLen };
}
