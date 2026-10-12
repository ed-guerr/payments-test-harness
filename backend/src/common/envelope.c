#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "pay/envelope.h"

int env_encode(uint16_t msg_id, const uint8_t *payload, uint32_t len, uint8_t *out, size_t out_cap,
               size_t *out_len)
{
    if (len > PF_MAX_PAYLOAD)
        return -1;

    size_t frame = PF_FRAME_HEADER + (size_t)len;
    if (out_cap < frame)
        return -1;

    uint16_t magic = PF_MAGIC;
    memcpy(out, &magic, 2);
    memcpy(out + 2, &msg_id, 2);
    memcpy(out + 4, &len, 4);
    if (len > 0)
        memcpy(out + PF_FRAME_HEADER, payload, len);

    *out_len = frame;
    return 0;
}

int env_decode(const uint8_t *buf, size_t len, Envelope *env, size_t *consumed)
{
    if (len < PF_FRAME_HEADER)
        return -1;

    uint16_t magic, msg_id;
    uint32_t payload_len;
    memcpy(&magic, buf, 2);
    memcpy(&msg_id, buf + 2, 2);
    memcpy(&payload_len, buf + 4, 4);

    if (magic != PF_MAGIC)
        return -2;
    if (payload_len > PF_MAX_PAYLOAD)
        return -3;
    if (len < PF_FRAME_HEADER + (size_t)payload_len)
        return -1;

    env->magic = magic;
    env->msg_id = msg_id;
    env->payload_len = payload_len;
    env->payload = buf + PF_FRAME_HEADER;
    *consumed = PF_FRAME_HEADER + (size_t)payload_len;
    return 0;
}
