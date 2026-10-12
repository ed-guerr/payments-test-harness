#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <string.h>

#include "handlers.h"
#include "pay/ack.h"
#include "pay/args.h"
#include "pay/db.h"
#include "pay/introspect.h"
#include "pay/log.h"
#include "pay/messages.h"
#include "pay/msg_ids.h"
#include "pay/socket.h"

static const MessageDef PAY_ORDERS_MSGS[] = {
    {MSG_CREATE_PAYMENT, "CreatePayment", "in", sizeof(CreatePaymentMsg), CreatePaymentMsg_fields,
     MSG_PAYMENT_ACK, handle_create_payment},
    {MSG_CANCEL_PAYMENT, "CancelPayment", "in", sizeof(CancelPaymentMsg), CancelPaymentMsg_fields,
     MSG_PAYMENT_ACK, handle_cancel_payment},
    {MSG_COMPLETE_PAYMENT, "CompletePayment", "in", sizeof(CompletePaymentMsg),
     CompletePaymentMsg_fields, MSG_PAYMENT_ACK, handle_complete_payment},
    {MSG_PAYMENT_ACK, "PaymentAck", "out", sizeof(PaymentAckMsg), PaymentAckMsg_fields, 0, NULL},
    {MSG_ERROR_ACK, "ErrorAck", "out", sizeof(ErrorAckMsg), ErrorAckMsg_fields, 0, NULL},
};

static int dispatch(Server *srv, int client, const Envelope *env)
{
    for (size_t i = 0; i < PF_ARRAY_LEN(PAY_ORDERS_MSGS); i++)
    {
        const MessageDef *def = &PAY_ORDERS_MSGS[i];

        if (def->id != env->msg_id || strcmp(def->direction, "in") != 0)
            continue;

        if (env->payload_len != def->struct_size)
        {
            log_msg("msg %s rejected: expected %zu bytes, got %u", def->name, def->struct_size,
                    env->payload_len);
            server_send_error(srv, client, env->msg_id, ERR_SIZE_MISMATCH, "payload size mismatch");
            return 0;
        }

        if (def->handler(srv, client, env) != 0)
            server_send_error(srv, client, env->msg_id, ERR_HANDLER, "handler error");
        return 0;
    }

    log_msg("unknown message id=%u", env->msg_id);
    server_send_error(srv, client, env->msg_id, ERR_UNKNOWN_MSG, "unknown message id");
    return 0;
}

int main(int argc, char **argv)
{
    Args args;
    if (args_parse(argc, argv, 9101, &args) != 0)
        return 2;

    if (args.introspect)
    {
        introspect_print("pay-orders", args.port, PAY_ORDERS_MSGS, PF_ARRAY_LEN(PAY_ORDERS_MSGS));
        return 0;
    }

    log_init("pay-orders");

    if (db_open(args.db_path) != 0)
        return 3;

    Server srv;
    if (server_bind(&srv, args.port) != 0)
        return 1;

    log_msg("listening on 127.0.0.1:%u db=%s", args.port, args.db_path);
    server_run(&srv, dispatch, "pay-orders");
    db_close();
    return 0;
}
