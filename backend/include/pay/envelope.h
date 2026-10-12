#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * Wire envelope (little-endian, 8-byte fixed header):
 *
 *   u16 magic        = 0x5046 ("PF")
 *   u16 msg_id
 *   u32 payload_len  (must be <= PF_MAX_PAYLOAD)
 *   u8  payload[]
 *
 * Payloads are packed C structs; the authoritative field layout for each
 * message is the FieldDef table emitted by `--introspect`.
 */

#define PF_MAGIC 0x5046u
#define PF_MAX_PAYLOAD 2048u
#define PF_FRAME_HEADER 8

typedef struct
{
    uint16_t magic;
    uint16_t msg_id;
    uint32_t payload_len;
    const uint8_t *payload; /* points into the caller's receive buffer */
} Envelope;

/*
 * Encode one frame into out.
 * Returns 0 and sets *out_len to the frame size, or -1 if len exceeds
 * PF_MAX_PAYLOAD or out_cap is too small.
 */
int env_encode(uint16_t msg_id, const uint8_t *payload, uint32_t len, uint8_t *out, size_t out_cap,
               size_t *out_len);

/*
 * Try to decode one frame from the start of buf.
 * Returns:
 *   0   complete frame; *env filled (payload points into buf), *consumed = frame size
 *  -1   buffer holds a partial frame; wait for more bytes
 *  -2   bad magic
 *  -3   payload_len > PF_MAX_PAYLOAD
 */
int env_decode(const uint8_t *buf, size_t len, Envelope *env, size_t *consumed);
