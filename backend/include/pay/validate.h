#pragma once

#include "pay/message.h"

/*
 * Wire-field validation. The protocol requires senders to NUL-terminate
 * fixed-width string fields; receivers validate (they never rely).
 *
 * validate_payload() walks the X-macro field table, so new messages get
 * checked without changes here:
 *   - every char[N] field must contain a NUL byte
 *   - a uint32 amount_cents field must be in 1..INT32_MAX (0 is rejected;
 *     above INT32_MAX the ledger's -(int32_t) cast would flip the sign of
 *     the debit)
 *
 * Returns 0 if the payload is well-formed, -1 otherwise.
 */
int validate_payload(const MessageDef *def, const void *payload);
