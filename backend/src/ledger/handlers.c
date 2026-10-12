#include "handlers.h"
#include "pay/ack.h"
#include "pay/db.h"
#include "pay/log.h"
#include "pay/messages.h"
#include "pay/msg_ids.h"
#include "pay/socket.h"

int handle_transfer_funds(Server *srv, int client, const Envelope *env)
{
    const TransferFundsMsg *msg = (const TransferFundsMsg *)env->payload;
    int32_t from_after = 0;
    int rc = db_transfer(msg->txn_id, msg->from_acct, msg->to_acct, msg->amount_cents, &from_after);

    TransferAckMsg ack;
    ack.txn_id = msg->txn_id;
    ack.from_balance_after = -1;

    switch (rc)
    {
        case 0:
            ack.status = TR_OK;
            ack.from_balance_after = from_after;
            log_msg("TransferFunds txn=%u %s -> %s %u ok (from now %d)", msg->txn_id,
                    msg->from_acct, msg->to_acct, msg->amount_cents, from_after);
            break;
        case -1:
            ack.status = TR_INSUFFICIENT;
            log_msg("TransferFunds txn=%u rejected: insufficient funds", msg->txn_id);
            break;
        case -2:
            ack.status = TR_NO_ACCOUNT;
            log_msg("TransferFunds txn=%u rejected: unknown account", msg->txn_id);
            break;
        case -3:
            ack.status = TR_SELF;
            log_msg("TransferFunds txn=%u rejected: self transfer", msg->txn_id);
            break;
        default:
            log_msg("TransferFunds txn=%u db error", msg->txn_id);
            return 1; /* internal error: dispatcher replies ErrorAck(ERR_HANDLER) */
    }

    return server_send(srv, client, MSG_TRANSFER_ACK, &ack, sizeof ack);
}

int handle_reverse_transfer(Server *srv, int client, const Envelope *env)
{
    const ReverseTransferMsg *msg = (const ReverseTransferMsg *)env->payload;
    int32_t from_after = 0;
    int rc = db_ledger_reverse(msg->txn_id, &from_after);

    TransferAckMsg ack;
    ack.txn_id = msg->txn_id;
    ack.from_balance_after = -1;

    if (rc == 0)
    {
        ack.status = TR_OK;
        ack.from_balance_after = from_after;
        log_msg("ReverseTransfer txn=%u ok (from now %d)", msg->txn_id, from_after);
    }
    else if (rc == -1)
    {
        ack.status = TR_NO_ENTRY;
        log_msg("ReverseTransfer txn=%u rejected: no applied entry", msg->txn_id);
    }
    else
    {
        ack.status = TR_NO_ENTRY; /* db error reported via ack; logged below */
        log_msg("ReverseTransfer txn=%u db error", msg->txn_id);
    }

    return server_send(srv, client, MSG_TRANSFER_ACK, &ack, sizeof ack);
}
