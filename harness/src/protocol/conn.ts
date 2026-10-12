/**
 * protocol/conn.ts — a framed TCP client for one backend process.
 *
 * One Conn per process. sendFrame writes a full frame; recv reads one full
 * frame with a deadline and validates the magic. Incoming bytes accumulate
 * in a buffer until a complete frame is present.
 */
import { EventEmitter } from "node:events";
import net from "node:net";
import { frameHeader, parseHeader } from "./codec";
import { FRAME_HEADER } from "./types";
import type { Frame } from "./types";

interface Pending {
  resolve: (f: Frame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class Conn extends EventEmitter {
  private sock: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;

  private constructor(sock: net.Socket) {
    super();
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("error", (err) => this.fail(err));
    sock.on("close", () => this.fail(new Error("connection closed")));
  }

  static async connect(port: number): Promise<Conn> {
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.once("connect", () => resolve(s));
      s.once("error", (e) => reject(e));
    });
    return new Conn(sock);
  }

  send(msgId: number, payload: Buffer): void {
    this.sock.write(Buffer.concat([frameHeader(msgId, payload.length), payload]));
  }

  /** Read one full frame, rejecting after `timeoutMs`. */
  recv(timeoutMs: number): Promise<Frame> {
    if (this.pending) throw new Error("recv already in flight");
    const timer = setTimeout(() => {
      this.fail(new Error(`recv timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    return new Promise<Frame>((resolve, reject) => {
      this.pending = { resolve, reject, timer };
    });
  }

  close(): void {
    this.sock.destroy();
  }

  get destroyed(): boolean {
    return this.sock.destroyed;
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < FRAME_HEADER) return;
      let parsed: { msgId: number; payloadLen: number };
      try {
        parsed = parseHeader(this.buf.subarray(0, FRAME_HEADER));
      } catch (e) {
        this.fail(e as Error);
        return;
      }
      const total = FRAME_HEADER + parsed.payloadLen;
      if (this.buf.length < total) return;
      const frame: Frame = {
        msgId: parsed.msgId,
        payload: Buffer.from(this.buf.subarray(FRAME_HEADER, total)),
      };
      this.buf = this.buf.subarray(total);
      const p = this.pending;
      this.pending = null;
      if (p) {
        clearTimeout(p.timer);
        p.resolve(frame);
        return;
      }
      // Unsolicited frame with no recv in flight: drop it (protocol is
      // strictly request/response on the client connections we use).
      this.emit("unsolicited", frame);
    }
  }

  private fail(err: Error): void {
    const p = this.pending;
    this.pending = null;
    this.buf = Buffer.alloc(0);
    if (p) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.emit("error", err);
  }
}
