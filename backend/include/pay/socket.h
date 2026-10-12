#pragma once

#include <stddef.h>
#include <stdint.h>

#include "pay/message.h"

/*
 * Minimal loopback TCP server: accept clients, accumulate their byte stream,
 * decode frames, and hand each complete Envelope to the process dispatch
 * function (which walks its MessageDef table).
 */

#define SOCK_MAX_CLIENTS 8
#define SOCK_BUF_CAP 65536

typedef struct
{
    int fd;
    uint8_t buf[SOCK_BUF_CAP];
    size_t len;
} ServerClient;

struct Server
{
    int listen_fd;
    uint16_t port;
    ServerClient clients[SOCK_MAX_CLIENTS];
};

/*
 * Bind + listen on 127.0.0.1:port (SO_REUSEADDR, non-blocking listen socket).
 * Returns 0, or -1 on failure (reason logged).
 */
int server_bind(Server *srv, uint16_t port);

/*
 * Run the accept/read/dispatch loop until the process exits.
 * dispatch() must return 0 to keep the client open, -1 to close it.
 */
void server_run(Server *srv, msg_handler_t dispatch, const char *proc_name);

/*
 * Send one frame to a client. Returns 0, or -1 on write failure
 * (the client is then closed).
 */
int server_send(Server *srv, int client, uint16_t msg_id, const void *payload, size_t len);

/*
 * Send a protocol ErrorAck (id 255) to a client. detail is truncated to fit
 * ErrorAckMsg.detail.
 */
void server_send_error(Server *srv, int client, uint16_t msg_id, uint8_t code, const char *detail);
