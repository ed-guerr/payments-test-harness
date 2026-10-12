#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include "pay/ack.h"
#include "pay/envelope.h"
#include "pay/log.h"
#include "pay/messages.h"
#include "pay/msg_ids.h"
#include "pay/socket.h"

#ifndef INADDR_LOOPBACK
#define INADDR_LOOPBACK 0x7F000001U
#endif

static int set_nonblocking(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0)
        return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int find_client_by_fd(Server *srv, int fd)
{
    for (int i = 0; i < SOCK_MAX_CLIENTS; i++)
    {
        if (srv->clients[i].fd == fd)
            return i;
    }
    return -1;
}

static int find_free_slot(Server *srv)
{
    for (int i = 0; i < SOCK_MAX_CLIENTS; i++)
    {
        if (srv->clients[i].fd < 0)
            return i;
    }
    return -1;
}

static void close_client(Server *srv, int idx)
{
    ServerClient *c = &srv->clients[idx];
    if (c->fd >= 0)
    {
        close(c->fd);
        c->fd = -1;
        c->len = 0;
    }
}

static int accept_clients(Server *srv, const char *proc_name)
{
    for (;;)
    {
        int fd = accept(srv->listen_fd, NULL, NULL);
        if (fd < 0)
            return 0; /* EAGAIN/ECONNABORTED: no more pending connects */

        int slot = find_free_slot(srv);
        if (slot < 0)
        {
            log_msg("%s: client rejected (all %d slots busy)", proc_name, SOCK_MAX_CLIENTS);
            close(fd);
            continue;
        }

        if (set_nonblocking(fd) != 0)
        {
            close(fd);
            continue;
        }

        srv->clients[slot].fd = fd;
        srv->clients[slot].len = 0;
        log_msg("%s: client %d connected", proc_name, slot);
    }
}

/* Write the full buffer; returns 0 or -1. */
static int write_all(int fd, const uint8_t *buf, size_t len)
{
    size_t off = 0;
    while (off < len)
    {
        ssize_t n = send(fd, buf + off, len - off, 0);
        if (n < 0)
        {
            if (errno == EINTR)
                continue;
            return -1;
        }
        off += (size_t)n;
    }
    return 0;
}

/*
 * Drain one client's buffer into dispatch calls.
 * Returns 0 to keep the client open, -1 to close it.
 */
static int drain_client(Server *srv, int idx, msg_handler_t dispatch, const char *proc_name)
{
    ServerClient *c = &srv->clients[idx];

    for (;;)
    {
        ssize_t n = recv(c->fd, c->buf + c->len, SOCK_BUF_CAP - c->len, 0);
        if (n > 0)
            c->len += (size_t)n;
        else if (n == 0)
            return -1; /* orderly shutdown from the client */
        else if (errno != EAGAIN && errno != EWOULDBLOCK)
            return -1;
        else
            break; /* EAGAIN: no more bytes right now */
    }

    for (;;)
    {
        Envelope env;
        size_t consumed = 0;
        int rc = env_decode(c->buf, c->len, &env, &consumed);

        if (rc == -1)
            return 0; /* partial frame: wait for more */

        if (rc != 0)
        {
            if (rc == -2)
                server_send_error(srv, idx, 0, ERR_BAD_MAGIC, "bad magic");
            else
                server_send_error(srv, idx, 0, ERR_OVERSIZED, "payload oversized");
            log_msg("%s: client %d protocol error (rc=%d)", proc_name, idx, rc);
            return -1;
        }

        size_t keep = c->len - consumed;
        if (keep > 0)
            memmove(c->buf, c->buf + consumed, keep);
        c->len = keep;

        if (dispatch(srv, idx, &env) != 0)
            return -1;
    }
}

int server_bind(Server *srv, uint16_t port)
{
    memset(srv, 0, sizeof *srv);
    srv->listen_fd = -1;
    srv->port = port;
    for (int i = 0; i < SOCK_MAX_CLIENTS; i++)
        srv->clients[i].fd = -1;

    srv->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (srv->listen_fd < 0)
    {
        log_msg("socket() failed: %s", strerror(errno));
        return -1;
    }

    int reuse = 1;
    setsockopt(srv->listen_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(srv->listen_fd, (struct sockaddr *)&addr, sizeof addr) != 0)
    {
        log_msg("bind 127.0.0.1:%u failed: %s", port, strerror(errno));
        close(srv->listen_fd);
        srv->listen_fd = -1;
        return -1;
    }

    if (listen(srv->listen_fd, SOCK_MAX_CLIENTS) != 0 || set_nonblocking(srv->listen_fd) != 0)
    {
        log_msg("listen 127.0.0.1:%u failed: %s", port, strerror(errno));
        close(srv->listen_fd);
        srv->listen_fd = -1;
        return -1;
    }

    return 0;
}

void server_run(Server *srv, msg_handler_t dispatch, const char *proc_name)
{
    for (;;)
    {
        struct pollfd pfds[SOCK_MAX_CLIENTS + 1];
        int n = 0;

        pfds[n].fd = srv->listen_fd;
        pfds[n].events = POLLIN;
        pfds[n].revents = 0;
        n++;

        for (int i = 0; i < SOCK_MAX_CLIENTS; i++)
        {
            if (srv->clients[i].fd >= 0)
            {
                pfds[n].fd = srv->clients[i].fd;
                pfds[n].events = POLLIN;
                pfds[n].revents = 0;
                n++;
            }
        }

        int rc = poll(pfds, (nfds_t)n, -1);
        if (rc < 0)
        {
            if (errno == EINTR)
                continue;
            log_msg("poll failed: %s", strerror(errno));
            return;
        }

        if (pfds[0].revents & POLLIN)
            accept_clients(srv, proc_name);

        for (int i = 1; i < n; i++)
        {
            int idx = find_client_by_fd(srv, pfds[i].fd);
            if (idx < 0)
                continue;

            int revents = pfds[i].revents;
            if (revents & (POLLIN | POLLHUP | POLLERR))
            {
                if (drain_client(srv, idx, dispatch, proc_name) != 0)
                {
                    log_msg("%s: client %d closed", proc_name, idx);
                    close_client(srv, idx);
                }
            }
        }
    }
}

int server_send(Server *srv, int client, uint16_t msg_id, const void *payload, size_t len)
{
    uint8_t frame[PF_FRAME_HEADER + PF_MAX_PAYLOAD];
    size_t frame_len = 0;

    if (client < 0 || client >= SOCK_MAX_CLIENTS || srv->clients[client].fd < 0)
        return -1;

    if (env_encode(msg_id, (const uint8_t *)payload, (uint32_t)len, frame, sizeof frame,
                   &frame_len) != 0)
        return -1;

    if (write_all(srv->clients[client].fd, frame, frame_len) != 0)
        return -1;

    return 0;
}

void server_send_error(Server *srv, int client, uint16_t msg_id, uint8_t code, const char *detail)
{
    ErrorAckMsg ack;
    memset(&ack, 0, sizeof ack);
    ack.msg_id = msg_id;
    ack.code = code;
    snprintf(ack.detail, sizeof ack.detail, "%s", detail);

    if (server_send(srv, client, MSG_ERROR_ACK, &ack, sizeof ack) != 0)
        close_client(srv, client);
}
