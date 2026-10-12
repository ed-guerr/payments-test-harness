/*
 * FieldDef tables for the full message catalog — the single definition of
 * every field name, C type, size and packed offset. --introspect prints
 * these as JSON; nothing else in the system re-declares a layout.
 */
#include "pay/messages.h"

/* PF_TYPE_STR: canonical wire-type strings for the introspection table. */
#define PF_TYPE_STR(t) PF_TYPE_STR_##t
#define PF_TYPE_STR_PF_S3 "char[3]"
#define PF_TYPE_STR_PF_S16 "char[16]"
#define PF_TYPE_STR_PF_S24 "char[24]"
#define PF_TYPE_STR_uint8_t "uint8_t"
#define PF_TYPE_STR_uint16_t "uint16_t"
#define PF_TYPE_STR_uint32_t "uint32_t"
#define PF_TYPE_STR_int32_t "int32_t"

/* PF_ENTRY: builds one FieldDef initializer per field. */
#define PF_ENTRY(T, name, type) {#name, PF_TYPE_STR(type), sizeof(type), offsetof(T, name)},

#define PF_TABLE(TYPE, LIST)                                                                       \
    const FieldDef TYPE##_fields[] = {LIST(TYPE, PF_ENTRY){NULL, NULL, 0, 0}};

PF_TABLE(CreatePaymentMsg, PF_FIELDS_CreatePayment)
PF_TABLE(CancelPaymentMsg, PF_FIELDS_CancelPayment)
PF_TABLE(CompletePaymentMsg, PF_FIELDS_CompletePayment)
PF_TABLE(PaymentAckMsg, PF_FIELDS_PaymentAck)

PF_TABLE(TransferFundsMsg, PF_FIELDS_TransferFunds)
PF_TABLE(ReverseTransferMsg, PF_FIELDS_ReverseTransfer)
PF_TABLE(TransferAckMsg, PF_FIELDS_TransferAck)

PF_TABLE(AuthorizeMsg, PF_FIELDS_Authorize)
PF_TABLE(SettleMsg, PF_FIELDS_Settle)
PF_TABLE(AuthResponseMsg, PF_FIELDS_AuthResponse)
PF_TABLE(SettleAckMsg, PF_FIELDS_SettleAck)

PF_TABLE(ErrorAckMsg, PF_FIELDS_ErrorAck)
