#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * Persistent client connections from the auth-gateway to the other
 * processes (fire-and-forget forwarding; failures are logged and retried on
 * the next message).
 */
enum
{
    FWD_PAY_ORDERS = 0,
    FWD_LEDGER = 1,
};

int fwd_init(uint16_t orders_port, uint16_t ledger_port);
int fwd_send(int target, uint16_t msg_id, const void *payload, size_t len);
void fwd_close(void);
