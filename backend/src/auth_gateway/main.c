#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <string.h>

#include "forward.h"
#include "handlers.h"
#include "pay/ack.h"
#include "pay/args.h"
#include "pay/db.h"
#include "pay/introspect.h"
#include "pay/log.h"
#include "pay/messages.h"
#include "pay/msg_ids.h"
#include "pay/socket.h"
#include "pay/validate.h"

static const MessageDef AUTH_GATEWAY_MSGS[] = {
    {MSG_AUTHORIZE, "Authorize", "in", sizeof(AuthorizeMsg), AuthorizeMsg_fields, MSG_AUTH_RESPONSE,
     handle_authorize},
    {MSG_SETTLE, "Settle", "in", sizeof(SettleMsg), SettleMsg_fields, MSG_SETTLE_ACK,
     handle_settle},
    {MSG_AUTH_RESPONSE, "AuthResponse", "out", sizeof(AuthResponseMsg), AuthResponseMsg_fields, 0,
     NULL},
    {MSG_SETTLE_ACK, "SettleAck", "out", sizeof(SettleAckMsg), SettleAckMsg_fields, 0, NULL},
    {MSG_ERROR_ACK, "ErrorAck", "out", sizeof(ErrorAckMsg), ErrorAckMsg_fields, 0, NULL},
};

static int dispatch(Server *srv, int client, const Envelope *env)
{
    for (size_t i = 0; i < PF_ARRAY_LEN(AUTH_GATEWAY_MSGS); i++)
    {
        const MessageDef *def = &AUTH_GATEWAY_MSGS[i];

        if (def->id != env->msg_id || strcmp(def->direction, "in") != 0)
            continue;

        if (env->payload_len != def->struct_size)
        {
            log_msg("msg %s rejected: expected %zu bytes, got %u", def->name, def->struct_size,
                    env->payload_len);
            server_send_error(srv, client, env->msg_id, ERR_SIZE_MISMATCH, "payload size mismatch");
            return 0;
        }

        if (validate_payload(def, env->payload) != 0)
        {
            log_msg("msg %s rejected: malformed field", def->name);
            server_send_error(srv, client, env->msg_id, ERR_BAD_FIELD, "malformed field");
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
    if (args_parse(argc, argv, 9103, &args) != 0)
        return 2;

    if (args.introspect)
    {
        introspect_print("auth-gateway", args.port, AUTH_GATEWAY_MSGS,
                         PF_ARRAY_LEN(AUTH_GATEWAY_MSGS));
        return 0;
    }

    log_init("auth-gateway");

    if (db_open(args.db_path) != 0)
        return 3;

    fwd_init(args.orders_port, args.ledger_port);

    Server srv;
    if (server_bind(&srv, args.port) != 0)
    {
        fwd_close();
        return 1;
    }

    log_msg("listening on 127.0.0.1:%u db=%s (forwards to pay-orders:%u ledger:%u)", args.port,
            args.db_path, args.orders_port, args.ledger_port);
    server_run(&srv, dispatch, "auth-gateway");
    fwd_close();
    db_close();
    return 0;
}
