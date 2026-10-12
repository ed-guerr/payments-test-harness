#pragma once

#include <stddef.h>
#include <stdint.h>

#include "pay/envelope.h"

/*
 * Self-describing message protocol (the core design point of this backend).
 *
 * Every wire message is declared exactly once as a field list:
 *
 *   #define PF_FIELDS_PaymentAck(F) \
 *       F(txn_id, uint32_t) \
 *       F(status, uint8_t)
 *
 * PF_MSG() turns each list into (a) the packed C struct the handlers use and
 * (b) an extern FieldDef table. The FieldDef tables are defined once in
 * src/common/messages.c, and `--introspect` prints them as JSON — that JSON
 * is the single source of truth for the test harness and the MCP server
 * (they never re-declare message layouts).
 */

/* Message structs are packed: sizeof == sum of field sizes, no alignment
 * padding. Offsets in the introspection JSON match the wire layout exactly. */
#define PF_PACKED __attribute__((packed))

#define PF_ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

typedef struct
{
    const char *name;
    const char *type; /* C type, e.g. "uint32_t" or "char[16]" */
    size_t size;
    size_t offset; /* byte offset in the packed struct */
} FieldDef;

typedef struct Server Server; /* opaque; defined in pay/socket.h */

/*
 * One message in a process's dispatch table.
 * Handlers return 0 on success; non-zero means "protocol-level failure" and
 * the dispatcher replies with ErrorAck(ERR_HANDLER).
 */
typedef int (*msg_handler_t)(Server *srv, int client, const Envelope *env);

/*
 * Field tables are sentinel-terminated: the last entry is {NULL, NULL, 0, 0}.
 * Consumers that need a count (introspection) walk to the sentinel.
 */

typedef struct
{
    uint16_t id;
    const char *name;
    const char *direction; /* "in" (accepted on the wire) or "out" (sent by this process) */
    size_t struct_size;
    const FieldDef *fields;
    uint16_t response_id; /* id of the ack this message produces; 0 = none */
    msg_handler_t handler;
} MessageDef;

/* Count fields up to the sentinel. */
static inline size_t field_count(const FieldDef *fields)
{
    size_t n = 0;
    while (fields[n].name != NULL)
        n++;
    return n;
}

/*
 * X-macro that defines a message struct + its extern field table.
 * LIST is the PF_FIELDS_<Name> field-list macro (takes T, F); TYPE is the
 * struct/typedef name. The struct body is built with the PF_MEMBER functor
 * (defined by the includer); the field table is built separately in
 * src/common/messages.c with the PF_ENTRY functor.
 */
#define PF_MSG(TYPE, LIST)                                                                         \
    typedef struct PF_PACKED TYPE                                                                  \
    {                                                                                              \
        LIST(TYPE, PF_MEMBER)                                                                      \
    } TYPE;                                                                                        \
    extern const FieldDef TYPE##_fields[];
