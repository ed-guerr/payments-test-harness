#!/usr/bin/env python3
"""End-to-end smoke test for the payments backend.

Stdlib only. It verifies:
  1. --introspect emits valid JSON with the expected messages and field layouts
  2. the three processes start and accept connections
  3. a full happy path: CreatePayment -> TransferFunds -> Authorize (which
     forwards CompletePayment) -> Settle (which forwards TransferFunds)
  4. error paths: duplicate txn, unknown account, insufficient funds,
     self-transfer, reverse transfer, already-settled, unknown message id,
     payload size mismatch, bad magic
  5. the resulting SQLite state (payment statuses + balances)

Usage:
  python3 backend/tools/smoke_test.py [--bin-dir build]
"""

import argparse
import json
import os
import sqlite3
import socket
import struct
import subprocess
import sys
import time

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MAGIC = 0x5046

TYPE_FMT = {"uint8_t": "B", "uint16_t": "H", "uint32_t": "I", "int32_t": "i"}

EXPECTED = {
    "pay-orders": {
        "port": 9101,
        "in": ["CreatePayment", "CancelPayment", "CompletePayment"],
        "out": ["PaymentAck", "ErrorAck"],
    },
    "ledger": {
        "port": 9102,
        "in": ["TransferFunds", "ReverseTransfer"],
        "out": ["TransferAck", "ErrorAck"],
    },
    "auth-gateway": {
        "port": 9103,
        "in": ["Authorize", "Settle"],
        "out": ["AuthResponse", "SettleAck", "ErrorAck"],
        "extra_args": ["--orders-port", "9101", "--ledger-port", "9102"],
    },
}


def fmt_for(fields):
    """Build a little-endian struct format from the registry's field table,
    inserting explicit x-pad bytes for any gaps (none exist for packed C
    structs, but the codec must be correct for any layout)."""
    fmt = "<"
    pos = 0
    for f in sorted(fields, key=lambda f: f["offset"]):
        gap = f["offset"] - pos
        if gap:
            fmt += f"{gap}x"
        if f["type"].startswith("char["):
            n = int(f["type"][5:-1])
            fmt += f"{n}s"
        else:
            fmt += TYPE_FMT[f["type"]]
        pos = f["offset"] + f["size"]
    return fmt


class Codec:
    """Registry-driven pack/unpack — the same strategy as the harness codec."""

    def __init__(self, registry):
        self.by_name = {proc: {m["name"]: m for m in data["messages"]} for proc, data in registry.items()}
        self.id_to_name = {
            proc: {m["id"]: m["name"] for m in data["messages"]} for proc, data in registry.items()
        }

    def name(self, proc, msg_id):
        return self.id_to_name[proc].get(msg_id, f"<id {msg_id}>")

    def size(self, proc, name):
        m = self.by_name[proc][name]
        return max(f["offset"] + f["size"] for f in m["fields"])

    def pack(self, proc, name, **fields):
        m = self.by_name[proc][name]
        vals = []
        for f in sorted(m["fields"], key=lambda f: f["offset"]):
            if f["name"] not in fields:
                raise AssertionError(f"{name}: missing field {f['name']}")
            v = fields[f["name"]]
            if f["type"].startswith("char["):
                v = v.encode()
            vals.append(v)
        return struct.pack(fmt_for(m["fields"]), *vals)

    def unpack(self, proc, name, buf):
        m = self.by_name[proc][name]
        if len(buf) != self.size(proc, name):
            raise AssertionError(f"{name}: payload is {len(buf)} bytes, expected {self.size(proc, name)}")
        vals = struct.unpack(fmt_for(m["fields"]), buf)
        out = {}
        for f, v in zip(sorted(m["fields"], key=lambda f: f["offset"]), vals):
            if f["type"].startswith("char["):
                v = v.split(b"\x00", 1)[0].decode()
            out[f["name"]] = v
        return out


class Conn:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=2.0)

    def send_frame(self, msg_id, payload):
        self.sock.sendall(struct.pack("<HHI", MAGIC, msg_id, len(payload)) + payload)

    def recv_frame(self, timeout=2.0):
        self.sock.settimeout(timeout)
        hdr = _read_exact(self.sock, 8)
        magic, msg_id, plen = struct.unpack("<HHI", hdr)
        if magic != MAGIC:
            raise AssertionError(f"bad magic {magic:#x}")
        return msg_id, _read_exact(self.sock, plen)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise AssertionError("connection closed mid-frame")
        buf += chunk
    return buf


def port_open(port, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=0.2)
            s.close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


class Smoke:
    def __init__(self, bin_dir):
        self.bin_dir = bin_dir
        self.db_path = os.path.join(bin_dir, "smoke.db")
        self.results = []
        self.procs = []

    def record(self, name, ok, detail=""):
        self.results.append((name, ok, detail))
        mark = "PASS" if ok else "FAIL"
        line = f"  {mark}  {name}"
        if detail and not ok:
            line += f"  -- {detail}"
        print(line)
        return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin-dir", default="build")
    args = ap.parse_args()

    bin_dir = os.path.abspath(os.path.join(BACKEND, args.bin_dir))
    smoke = Smoke(bin_dir)
    ok_all = True

    print("== 1. introspection ==")
    registry = {}
    for proc, spec in EXPECTED.items():
        bin_path = os.path.join(bin_dir, proc)
        if not os.path.isfile(bin_path):
            smoke.record(f"introspect {proc}", False, f"missing binary — run `make` in backend/ first")
            ok_all = False
            continue
        proc_out = subprocess.run([bin_path, "--introspect"], capture_output=True, text=True)
        if proc_out.returncode != 0:
            smoke.record(f"introspect {proc}", False, f"exit {proc_out.returncode}: {proc_out.stderr.strip()}")
            ok_all = False
            continue
        try:
            data = json.loads(proc_out.stdout)
        except json.JSONDecodeError as e:
            smoke.record(f"introspect {proc}", False, f"invalid JSON: {e}")
            ok_all = False
            continue

        registry[proc] = data
        names = {m["name"] for m in data["messages"]}
        missing = [n for n in spec["in"] + spec["out"] if n not in names]
        if missing:
            smoke.record(f"introspect {proc}", False, f"missing messages: {missing}")
            ok_all = False
            continue

        # layout sanity: offsets sorted, sizes positive, contiguous packing
        layout_ok = True
        for m in data["messages"]:
            fields = sorted(m["fields"], key=lambda f: f["offset"])
            if any(f["size"] <= 0 for f in fields):
                layout_ok = False
                break
            if m["size"] != max(f["offset"] + f["size"] for f in fields):
                layout_ok = False
                break
        smoke.record(f"introspect {proc}", layout_ok, "field layout inconsistent with declared size")

    if not ok_all:
        print("\nsmoke test aborted: introspection failed")
        return 1

    codec = Codec(registry)

    print("== 2. database setup ==")
    for ext in ("", "-wal", "-shm"):
        p = smoke.db_path + ext
        if os.path.exists(p):
            os.remove(p)
    schema = open(os.path.join(BACKEND, "db", "schema.sql")).read()
    conn = sqlite3.connect(smoke.db_path)
    conn.executescript(schema)
    conn.close()
    smoke.record("database initialized", True)

    print("== 3. start processes ==")
    for proc, spec in EXPECTED.items():
        # make sure nothing else is already bound to the ports
        if port_open(spec["port"], timeout=0.3):
            smoke.record(f"start {proc}", False, f"port {spec['port']} already in use — stop other instances first")
            ok_all = False
            break
        log = open(os.path.join(bin_dir, f"smoke-{proc}.log"), "w")
        p = subprocess.Popen(
            [os.path.join(bin_dir, proc), "--db", smoke.db_path, "--port", str(spec["port"])]
            + spec.get("extra_args", []),
            stdout=subprocess.DEVNULL,
            stderr=log,
        )
        smoke.procs.append((proc, p, log))
    else:
        socks = {}
        for proc, spec in EXPECTED.items():
            if not port_open(spec["port"]):
                smoke.record(f"start {proc}", False, f"port {spec['port']} not reachable within 5s")
                ok_all = False
                continue
            smoke.record(f"start {proc}", True)
            socks[proc] = Conn(spec["port"])
        if ok_all:
            ok_all = _run_flow(smoke, codec, socks)
        for s in socks.values():
            s.close()

    # teardown
    for proc, p, log in smoke.procs:
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()
        log.close()

    print("== summary ==")
    passed = sum(1 for _, ok, _ in smoke.results if ok)
    failed = [n for n, ok, _ in smoke.results if not ok]
    print(f"  {passed}/{len(smoke.results)} checks passed")
    if failed:
        print(f"  failed: {failed}")
        return 1
    print("  all checks passed")
    return 0


def _run_flow(smoke, codec, socks):
    c = smoke.record
    pay, led, gw = socks["pay-orders"], socks["ledger"], socks["auth-gateway"]

    # -- happy path ----------------------------------------------------------
    pay.send_frame(10, codec.pack("pay-orders", "CreatePayment", txn_id=9001, account="ACCT-001",
                                  amount_cents=1000, currency="USD"))
    mid, buf = pay.recv_frame()
    ack = codec.unpack("pay-orders", codec.name("pay-orders", mid), buf)
    c("CreatePayment 9001 -> ack 0", mid == 20 and ack["txn_id"] == 9001 and ack["status"] == 0, str(ack))

    pay.send_frame(10, codec.pack("pay-orders", "CreatePayment", txn_id=9001, account="ACCT-001",
                                  amount_cents=1000, currency="USD"))
    mid, buf = pay.recv_frame()
    ack = codec.unpack("pay-orders", codec.name("pay-orders", mid), buf)
    c("duplicate CreatePayment 9001 -> ack 2", ack["status"] == 2, str(ack))

    pay.send_frame(10, codec.pack("pay-orders", "CreatePayment", txn_id=9004, account="ACCT-999",
                                  amount_cents=1, currency="USD"))
    mid, buf = pay.recv_frame()
    ack = codec.unpack("pay-orders", codec.name("pay-orders", mid), buf)
    c("CreatePayment unknown account -> ack 1", ack["status"] == 1, str(ack))

    led.send_frame(30, codec.pack("ledger", "TransferFunds", txn_id=9001, from_acct="ACCT-001",
                                  to_acct="ACCT-002", amount_cents=1000))
    mid, buf = led.recv_frame()
    ack = codec.unpack("ledger", codec.name("ledger", mid), buf)
    c("TransferFunds 9001 -> ack 0, balance 499000",
      ack["status"] == 0 and ack["from_balance_after"] == 499000, str(ack))

    led.send_frame(30, codec.pack("ledger", "TransferFunds", txn_id=9002, from_acct="ACCT-002",
                                  to_acct="RESERVE", amount_cents=999999999))
    mid, buf = led.recv_frame()
    ack = codec.unpack("ledger", codec.name("ledger", mid), buf)
    c("TransferFunds insufficient -> ack 1", ack["status"] == 1 and ack["from_balance_after"] == -1, str(ack))

    led.send_frame(30, codec.pack("ledger", "TransferFunds", txn_id=9005, from_acct="ACCT-001",
                                  to_acct="ACCT-001", amount_cents=1))
    mid, buf = led.recv_frame()
    ack = codec.unpack("ledger", codec.name("ledger", mid), buf)
    c("TransferFunds self -> ack 3", ack["status"] == 3, str(ack))

    gw.send_frame(40, codec.pack("auth-gateway", "Authorize", txn_id=9001, amount_cents=1000))
    mid, buf = gw.recv_frame()
    resp = codec.unpack("auth-gateway", codec.name("auth-gateway", mid), buf)
    c("Authorize 9001 -> approved, code AU-0009001",
      resp["approved"] == 1 and resp["auth_code"] == "AU-0009001", str(resp))

    time.sleep(0.3)  # allow the CompletePayment forward to land
    conn = sqlite3.connect(smoke.db_path)
    status = conn.execute("SELECT status FROM payments WHERE txn_id = 9001").fetchone()[0]
    conn.close()
    c("forward: payment 9001 now complete", status == "complete", f"status={status}")

    gw.send_frame(41, codec.pack("auth-gateway", "Settle", txn_id=9001, fee_cents=10))
    mid, buf = gw.recv_frame()
    ack = codec.unpack("auth-gateway", codec.name("auth-gateway", mid), buf)
    c("Settle 9001 -> settled 1000", ack["status"] == 0 and ack["settled_cents"] == 1000, str(ack))

    gw.send_frame(41, codec.pack("auth-gateway", "Settle", txn_id=9001, fee_cents=10))
    mid, buf = gw.recv_frame()
    ack = codec.unpack("auth-gateway", codec.name("auth-gateway", mid), buf)
    c("Settle 9001 again -> ack 2 (already settled)", ack["status"] == 2, str(ack))

    gw.send_frame(40, codec.pack("auth-gateway", "Authorize", txn_id=9001, amount_cents=1000))
    mid, buf = gw.recv_frame()
    resp = codec.unpack("auth-gateway", codec.name("auth-gateway", mid), buf)
    c("Authorize settled payment -> denied", resp["approved"] == 0, str(resp))

    # -- reverse transfer ------------------------------------------------------
    pay.send_frame(10, codec.pack("pay-orders", "CreatePayment", txn_id=9003, account="ACCT-002",
                                  amount_cents=500, currency="USD"))
    pay.recv_frame()
    led.send_frame(30, codec.pack("ledger", "TransferFunds", txn_id=9003, from_acct="ACCT-002",
                                  to_acct="ACCT-001", amount_cents=500))
    mid, buf = led.recv_frame()
    ack = codec.unpack("ledger", codec.name("ledger", mid), buf)
    c("TransferFunds 9003 (002->001) ok", ack["status"] == 0, str(ack))

    led.send_frame(31, codec.pack("ledger", "ReverseTransfer", txn_id=9003))
    mid, buf = led.recv_frame()
    ack = codec.unpack("ledger", codec.name("ledger", mid), buf)
    c("ReverseTransfer 9003 ok", ack["status"] == 0, str(ack))

    led.send_frame(31, codec.pack("ledger", "ReverseTransfer", txn_id=9003))
    mid, buf = led.recv_frame()
    ack = codec.unpack("ledger", codec.name("ledger", mid), buf)
    c("ReverseTransfer 9003 again -> ack 4 (no entry)", ack["status"] == 4, str(ack))

    # -- cancel ----------------------------------------------------------------
    pay.send_frame(10, codec.pack("pay-orders", "CreatePayment", txn_id=9006, account="ACCT-002",
                                  amount_cents=777, currency="USD"))
    pay.recv_frame()
    pay.send_frame(11, codec.pack("pay-orders", "CancelPayment", txn_id=9006, reason="user"))
    mid, buf = pay.recv_frame()
    ack = codec.unpack("pay-orders", codec.name("pay-orders", mid), buf)
    c("CancelPayment 9006 -> ack 0", ack["status"] == 0, str(ack))

    # -- protocol errors ---------------------------------------------------------
    pay.send_frame(999, b"\x00\x00\x00\x00")
    mid, buf = pay.recv_frame()
    err = codec.unpack("pay-orders", codec.name("pay-orders", mid), buf)
    c("unknown message id -> ErrorAck code 1", mid == 255 and err["code"] == 1 and err["msg_id"] == 999, str(err))

    pay.send_frame(10, b"\x00" * 10)  # CreatePayment expects 27 bytes
    mid, buf = pay.recv_frame()
    err = codec.unpack("pay-orders", codec.name("pay-orders", mid), buf)
    c("size mismatch -> ErrorAck code 4", mid == 255 and err["code"] == 4, str(err))

    bad = Conn(9101)
    bad.sock.sendall(b"\xde\xad\xbe\xef" + b"\x00" * 4)
    try:
        mid, buf = bad.recv_frame()
        err = codec.unpack("pay-orders", codec.name("pay-orders", mid), buf)
        leftover = bad.sock.recv(64)
        ok = mid == 255 and err["code"] == 2 and leftover == b""
        c("bad magic -> ErrorAck code 2, then close", ok, f"mid={mid} err={err} leftover={leftover!r}")
    except (AssertionError, OSError) as e:
        c("bad magic -> ErrorAck code 2, then close", False, str(e))
    finally:
        bad.close()

    # -- final database state ----------------------------------------------------
    conn = sqlite3.connect(smoke.db_path)
    balances = dict(conn.execute("SELECT acct, balance_cents FROM accounts").fetchall())
    status = conn.execute("SELECT status FROM payments WHERE txn_id = 9001").fetchone()[0]
    entry_status = conn.execute(
        "SELECT status FROM ledger_entries WHERE txn_id = 9003").fetchone()[0]
    conn.close()

    c("payment 9001 settled in db", status == "settled", f"status={status}")
    c("ledger entry 9003 reversed in db", entry_status == "reversed", f"status={entry_status}")
    expected_balances = {"ACCT-001": 498000, "ACCT-002": 251000, "RESERVE": 1001000}
    c("balances 498000/251000/1001000", balances == expected_balances, str(balances))

    return all(ok for _, ok, _ in smoke.results)


if __name__ == "__main__":
    sys.exit(main())
