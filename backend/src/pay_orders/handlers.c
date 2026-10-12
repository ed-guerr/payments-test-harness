#include "handlers.h"
#include "pay/ack.h"
#include "pay/db.h"
#include "pay/log.h"
#include "pay/messages.h"
#include "pay/msg_ids.h"
#include "pay/socket.h"

int handle_create_payment(Server *srv, int client, const Envelope *env)
{
    const CreatePaymentMsg *msg = (const CreatePaymentMsg *)env->payload;
    PaymentAckMsg ack;
    ack.txn_id = msg->txn_id;
    ack.status = ACK_INVALID;

    if (db_account_exists(msg->account) != 0)
    {
        log_msg("CreatePayment txn=%u rejected: unknown account %s", msg->txn_id, msg->account);
        ack.status = ACK_ACCOUNT_NOT_FOUND;
    }
    else
    {
        int rc = db_payment_insert(msg->txn_id, msg->account, msg->amount_cents, msg->currency);
        if (rc == -1)
        {
            log_msg("CreatePayment txn=%u rejected: duplicate txn", msg->txn_id);
            ack.status = ACK_DUPLICATE_TXN;
        }
        else if (rc == 0)
        {
            log_msg("CreatePayment txn=%u account=%s amount=%u %s -> open", msg->txn_id,
                    msg->account, msg->amount_cents, msg->currency);
            ack.status = ACK_OK;
        }
        else
        {
            log_msg("CreatePayment txn=%u db error", msg->txn_id);
            ack.status = ACK_INVALID;
        }
    }

    return server_send(srv, client, MSG_PAYMENT_ACK, &ack, sizeof ack);
}

int handle_cancel_payment(Server *srv, int client, const Envelope *env)
{
    const CancelPaymentMsg *msg = (const CancelPaymentMsg *)env->payload;
    PaymentAckMsg ack;
    ack.txn_id = msg->txn_id;
    ack.status = ACK_INVALID;

    if (db_payment_set_status(msg->txn_id, "open", "cancelled") == 0)
    {
        log_msg("CancelPayment txn=%u reason=%s -> cancelled", msg->txn_id, msg->reason);
        ack.status = ACK_OK;
    }
    else
    {
        log_msg("CancelPayment txn=%u rejected: not open", msg->txn_id);
    }

    return server_send(srv, client, MSG_PAYMENT_ACK, &ack, sizeof ack);
}

int handle_complete_payment(Server *srv, int client, const Envelope *env)
{
    const CompletePaymentMsg *msg = (const CompletePaymentMsg *)env->payload;
    PaymentAckMsg ack;
    ack.txn_id = msg->txn_id;
    ack.status = ACK_INVALID;

    if (db_payment_set_status(msg->txn_id, "open", "complete") == 0)
    {
        log_msg("CompletePayment txn=%u -> complete", msg->txn_id);
        ack.status = ACK_OK;
    }
    else
    {
        log_msg("CompletePayment txn=%u rejected: not open", msg->txn_id);
    }

    return server_send(srv, client, MSG_PAYMENT_ACK, &ack, sizeof ack);
}
