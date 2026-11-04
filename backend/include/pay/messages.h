#pragma once

#include "pay/message.h"

/*
 * The full banking message catalog. Struct definitions are shared by all
 * three processes (the auth-gateway forwards messages between them), while
 * each process's dispatch table — which ids it accepts and which handlers
 * answer them — lives in that process's main.c.
 *
 * All monetary amounts are integer cents. All char[] fields are NUL-padded
 * on the wire (senders must NUL-terminate; receivers validate it).
 */

/*
 * Fixed-size field aliases used in the field lists below. Array types cannot
 * appear in prefix position in a member declaration ("char[16] name" is
 * invalid C), so field lists name these aliases instead; the introspection
 * table maps them back to their canonical "char[N]" strings.
 */
typedef char PF_S3[3];
typedef char PF_S4[4];
typedef char PF_S16[16];
typedef char PF_S24[24];

/*
 * Field lists take (T, F): the struct type (for offsetof) and the functor F,
 * which is invoked once per field as F(T, name, type).
 */

/* --- pay-orders --- */

#define PF_FIELDS_CreatePayment(T, F)                                                              \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, account, PF_S16)                                                                          \
    F(T, amount_cents, uint32_t)                                                                   \
    F(T, currency, PF_S4)

#define PF_FIELDS_CancelPayment(T, F)                                                              \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, reason, PF_S16)

#define PF_FIELDS_CompletePayment(T, F) F(T, txn_id, uint32_t)

#define PF_FIELDS_PaymentAck(T, F)                                                                 \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, status, uint8_t)

/* --- ledger --- */

#define PF_FIELDS_TransferFunds(T, F)                                                              \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, from_acct, PF_S16)                                                                        \
    F(T, to_acct, PF_S16)                                                                          \
    F(T, amount_cents, uint32_t)

#define PF_FIELDS_ReverseTransfer(T, F) F(T, txn_id, uint32_t)

#define PF_FIELDS_TransferAck(T, F)                                                                \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, status, uint8_t)                                                                          \
    F(T, from_balance_after, int32_t)

/* --- auth-gateway --- */

#define PF_FIELDS_Authorize(T, F)                                                                  \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, amount_cents, uint32_t)

#define PF_FIELDS_Settle(T, F)                                                                     \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, fee_cents, uint16_t)

#define PF_FIELDS_AuthResponse(T, F)                                                               \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, approved, uint8_t)                                                                        \
    F(T, auth_code, PF_S16)

#define PF_FIELDS_SettleAck(T, F)                                                                  \
    F(T, txn_id, uint32_t)                                                                         \
    F(T, status, uint8_t)                                                                          \
    F(T, settled_cents, uint32_t)

/* --- all processes --- */

#define PF_FIELDS_ErrorAck(T, F)                                                                   \
    F(T, msg_id, uint16_t)                                                                         \
    F(T, code, uint8_t)                                                                            \
    F(T, detail, PF_S24)

/* --- structs + field tables --- */

/* PF_MEMBER: struct-body functor (T unused). */
#define PF_MEMBER(T, name, type) type name;

PF_MSG(CreatePaymentMsg, PF_FIELDS_CreatePayment)
PF_MSG(CancelPaymentMsg, PF_FIELDS_CancelPayment)
PF_MSG(CompletePaymentMsg, PF_FIELDS_CompletePayment)
PF_MSG(PaymentAckMsg, PF_FIELDS_PaymentAck)

PF_MSG(TransferFundsMsg, PF_FIELDS_TransferFunds)
PF_MSG(ReverseTransferMsg, PF_FIELDS_ReverseTransfer)
PF_MSG(TransferAckMsg, PF_FIELDS_TransferAck)

PF_MSG(AuthorizeMsg, PF_FIELDS_Authorize)
PF_MSG(SettleMsg, PF_FIELDS_Settle)
PF_MSG(AuthResponseMsg, PF_FIELDS_AuthResponse)
PF_MSG(SettleAckMsg, PF_FIELDS_SettleAck)

PF_MSG(ErrorAckMsg, PF_FIELDS_ErrorAck)
