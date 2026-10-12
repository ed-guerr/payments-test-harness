#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include "forward.h"

#include "pay/envelope.h"
#include "pay/log.h"

#ifndef INADDR_LOOPBACK
#define INADDR_LOOPBACK 0x7F000001U
#endif

typedef struct
{
    int fd;
    uint16_t port;
    const char *name;
} FwdConn;

static FwdConn conns[2];

static int connect_to(uint16_t port)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0)
    {
        close(fd);
        return -1;
    }

    return fd;
}

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

int fwd_init(uint16_t orders_port, uint16_t ledger_port)
{
    conns[FWD_PAY_ORDERS].fd = -1;
    conns[FWD_PAY_ORDERS].port = orders_port;
    conns[FWD_PAY_ORDERS].name = "pay-orders";
    conns[FWD_LEDGER].fd = -1;
    conns[FWD_LEDGER].port = ledger_port;
    conns[FWD_LEDGER].name = "ledger";
    return 0;
}

int fwd_send(int target, uint16_t msg_id, const void *payload, size_t len)
{
    if (target < 0 || target > FWD_LEDGER)
        return -1;

    FwdConn *c = &conns[target];

    if (c->fd < 0)
    {
        c->fd = connect_to(c->port);
        if (c->fd < 0)
        {
            log_msg("forward to %s: connect 127.0.0.1:%u failed: %s", c->name, c->port,
                    strerror(errno));
            return -1;
        }
        log_msg("forward: connected to %s 127.0.0.1:%u", c->name, c->port);
    }

    uint8_t frame[PF_FRAME_HEADER + PF_MAX_PAYLOAD];
    size_t frame_len = 0;
    if (env_encode(msg_id, (const uint8_t *)payload, (uint32_t)len, frame, sizeof frame,
                   &frame_len) != 0)
        return -1;

    if (write_all(c->fd, frame, frame_len) != 0)
    {
        log_msg("forward to %s: write failed: %s", c->name, strerror(errno));
        close(c->fd);
        c->fd = -1;
        return -1;
    }

    return 0;
}

void fwd_close(void)
{
    for (int i = 0; i < 2; i++)
    {
        if (conns[i].fd >= 0)
        {
            close(conns[i].fd);
            conns[i].fd = -1;
        }
    }
}
