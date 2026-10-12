#pragma once

/* PaymentAck.status */
#define ACK_OK 0
#define ACK_ACCOUNT_NOT_FOUND 1
#define ACK_DUPLICATE_TXN 2
#define ACK_INVALID 3

/* TransferAck.status */
#define TR_OK 0
#define TR_INSUFFICIENT 1
#define TR_NO_ACCOUNT 2
#define TR_SELF 3
#define TR_NO_ENTRY 4

/* SettleAck.status */
#define ST_OK 0
#define ST_NOT_COMPLETE 1
#define ST_SETTLED 2

/* ErrorAck.code (protocol / transport errors) */
#define ERR_UNKNOWN_MSG 1
#define ERR_BAD_MAGIC 2
#define ERR_OVERSIZED 3
#define ERR_SIZE_MISMATCH 4
#define ERR_HANDLER 5
