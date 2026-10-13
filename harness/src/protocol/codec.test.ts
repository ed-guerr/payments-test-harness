/**
 * protocol/codec.test.ts — the codec is the single most load-bearing piece
 * of the harness (every wire byte goes through it), so round-trip every
 * message in the registry, not just a sample.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as codec from "./codec";
import type { FieldValue } from "./types";

function sampleFields(proc: string, name: string): Record<string, FieldValue> {
  const m = codec.getProc(proc).messages.find((x) => x.name === name);
  assert.ok(m, `${proc}/${name} must be in the registry`);
  const out: Record<string, FieldValue> = {};
  for (const f of m!.fields) {
    out[f.name] = f.type.startsWith("char[") ? "A".repeat(Math.min(4, f.size - 1)) : 7;
  }
  return out;
}

test("pack→unpack round-trips every message in the registry", () => {
  let n = 0;
  for (const proc of codec.listProcs()) {
    for (const m of codec.getProc(proc).messages) {
      const fields = sampleFields(proc, m.name);
      const buf = codec.pack(proc, m.name, fields);
      assert.equal(buf.length, m.size, `${proc}/${m.name}: packed size`);
      assert.deepEqual(codec.unpack(proc, m.name, buf), fields, `${proc}/${m.name}`);
      n++;
    }
  }
  // 11 protocol messages (3 procs x in/out) — fail loudly if the registry shrinks
  assert.ok(n >= 11, `expected 11+ messages in the registry, saw ${n}`);
});

test("pack rejects unknown message, missing field, and wrong type", () => {
  assert.throws(() => codec.pack("pay-orders", "Nope", {}), /unknown message/);
  assert.throws(() => codec.pack("pay-orders", "CreatePayment", {}), /missing field/);
  const fields = sampleFields("pay-orders", "CreatePayment");
  (fields as Record<string, unknown>).currency = 42; // number into a char[] field
  assert.throws(() => codec.pack("pay-orders", "CreatePayment", fields), /expected string/);
});

test("unpack rejects a payload of the wrong length", () => {
  const buf = codec.pack("pay-orders", "PaymentAck", sampleFields("pay-orders", "PaymentAck"));
  assert.throws(
    () => codec.unpack("pay-orders", "PaymentAck", buf.subarray(0, buf.length - 1)),
    /expected/,
  );
});

test("frame header round-trips; bad magic is rejected", () => {
  const hdr = codec.frameHeader(10, 27);
  assert.deepEqual(codec.parseHeader(hdr), { msgId: 10, payloadLen: 27 });
  const bad = Buffer.from(hdr);
  bad.writeUInt16LE(0xdead, 0);
  assert.throws(() => codec.parseHeader(bad), /bad magic/);
});
