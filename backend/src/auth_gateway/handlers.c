#include <stdio.h>
#include <string.h>

#include "forward.h"
#include "handlers.h"
#include "pay/ack.h"
#include "pay/db.h"
#include "pay/faults.h"
#include "pay/log.h"
#include "pay/messages.h"
#include "pay/msg_ids.h"
#include "pay/socket.h"

int handle_authorize(Server *srv, int client, const Envelope *env)
{
    const AuthorizeMsg *msg = (const AuthorizeMsg *)env->payload;

    AuthResponseMsg resp;
    memset(&resp, 0, sizeof resp);
    resp.txn_id = msg->txn_id;
    resp.approved = 0;

    char account[16] = {0};
    char status[16] = {0};
    uint32_t amount = 0;

    if (db_payment_get(msg->txn_id, account, &amount, status) == 0 && strcmp(status, "open") == 0)
    {
        resp.approved = 1;
        snprintf(resp.auth_code, sizeof resp.auth_code, "AU-%07u", msg->txn_id);
        log_msg("Authorize txn=%u approved (auth=%s)", msg->txn_id, resp.auth_code);

        /* Forwarding is fire-and-forget: the payment stays open until
         * Settle; if pay-orders is down, Settle will refuse with
         * ST_NOT_COMPLETE. */
        CompletePaymentMsg fwd;
        fwd.txn_id = msg->txn_id;
        if (fault_active("skip_forward"))
        {
            /* Fault: the gateway approves but never forwards
             * CompletePayment — the payment stays open forever. */
            log_msg("Authorize txn=%u: [fault skip_forward] forward skipped", msg->txn_id);
        }
        else if (fwd_send(FWD_PAY_ORDERS, MSG_COMPLETE_PAYMENT, &fwd, sizeof fwd) != 0)
            log_msg("Authorize txn=%u: forward of CompletePayment failed (will retry on next send)",
                    msg->txn_id);
    }
    else
    {
        log_msg("Authorize txn=%u rejected: payment not open", msg->txn_id);
    }

    return server_send(srv, client, MSG_AUTH_RESPONSE, &resp, sizeof resp);
}

int handle_settle(Server *srv, int client, const Envelope *env)
{
    const SettleMsg *msg = (const SettleMsg *)env->payload;

    SettleAckMsg ack;
    memset(&ack, 0, sizeof ack);
    ack.txn_id = msg->txn_id;
    ack.status = ST_NOT_COMPLETE;

    char account[16] = {0};
    char status[16] = {0};
    uint32_t amount = 0;

    if (db_payment_get(msg->txn_id, account, &amount, status) != 0)
    {
        log_msg("Settle txn=%u rejected: no such payment", msg->txn_id);
    }
    else if (strcmp(status, "settled") == 0 && !fault_active("double_settle_ok"))
    {
        /* Fault double_settle_ok: already-settled payments skip this
         * check and fall through as "not complete". */
        ack.status = ST_SETTLED;
        log_msg("Settle txn=%u rejected: already settled", msg->txn_id);
    }
    else if (strcmp(status, "complete") != 0)
    {
        log_msg("Settle txn=%u rejected: payment not complete (status=%s)", msg->txn_id, status);
    }
    else
    {
        log_msg("Settle txn=%u moving %u from %s to %s (fee %u, not modeled in ledger)",
                msg->txn_id, amount, account, PF_RESERVE_ACCOUNT, msg->fee_cents);

        TransferFundsMsg fwd;
        fwd.txn_id = msg->txn_id;
        memcpy(fwd.from_acct, account, sizeof fwd.from_acct);
        /* Fault settle_wrong_acct: settle into a seeded account instead of
         * the reserve — money lands where the books don't expect it. */
        snprintf(fwd.to_acct, sizeof fwd.to_acct, "%s",
                 fault_active("settle_wrong_acct") ? "ACCT-002" : PF_RESERVE_ACCOUNT);
        fwd.amount_cents = amount;

        if (fwd_send(FWD_LEDGER, MSG_TRANSFER_FUNDS, &fwd, sizeof fwd) != 0)
        {
            log_msg("Settle txn=%u: forward of TransferFunds failed", msg->txn_id);
        }
        else if (db_payment_set_status(msg->txn_id, "complete", "settled") == 0)
        {
            ack.status = ST_OK;
            ack.settled_cents = amount;
            log_msg("Settle txn=%u settled", msg->txn_id);
        }
        else
        {
            log_msg("Settle txn=%u: status changed under us", msg->txn_id);
        }
    }

    return server_send(srv, client, MSG_SETTLE_ACK, &ack, sizeof ack);
}
