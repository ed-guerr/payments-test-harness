#pragma once

#include <stdint.h>

/*
 * Message id spaces are per-process (a message id is only meaningful on the
 * process that owns it). ErrorAck (255) is shared by all processes.
 */

/* pay-orders (:9101) */
#define MSG_CREATE_PAYMENT 10
#define MSG_CANCEL_PAYMENT 11
#define MSG_COMPLETE_PAYMENT 12
#define MSG_PAYMENT_ACK 20

/* ledger (:9102) */
#define MSG_TRANSFER_FUNDS 30
#define MSG_REVERSE_TRANSFER 31
#define MSG_TRANSFER_ACK 32

/* auth-gateway (:9103) */
#define MSG_AUTHORIZE 40
#define MSG_SETTLE 41
#define MSG_AUTH_RESPONSE 42
#define MSG_SETTLE_ACK 43

/* all processes */
#define MSG_ERROR_ACK 255

/* Ledger account that receives settlement proceeds. */
#define PF_RESERVE_ACCOUNT "RESERVE"
