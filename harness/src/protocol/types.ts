/**
 * protocol/types.ts — types for the wire protocol registry.
 *
 * The registry (registry.json) is generated from the C binaries'
 * `--introspect` output (see scripts/gen_registry.js). These types mirror
 * that JSON exactly; the codec derives packing behavior from it.
 */

export interface FieldDef {
  name: string;
  /** C type as emitted by introspection: uint8_t | uint16_t | uint32_t | int32_t | char[N] */
  type: string;
  size: number;
  /** byte offset within the packed payload */
  offset: number;
}

export interface MessageDef {
  id: number;
  name: string;
  direction: "in" | "out";
  size: number;
  /** id of the ack/response message, or 0 when none */
  response: number;
  fields: FieldDef[];
  /** Optional knowledge-base note (precondition + side effect), attached by the MCP server. */
  notes?: string;
}

export interface ProcDef {
  process: string;
  listen: string;
  messages: MessageDef[];
}

export interface Registry {
  procs: Record<string, ProcDef>;
}

/** A decoded field value: number or string (char[N]). */
export type FieldValue = number | string;

export interface Frame {
  msgId: number;
  payload: Buffer;
}

export const MAGIC = 0x5046;
export const FRAME_HEADER = 8;
