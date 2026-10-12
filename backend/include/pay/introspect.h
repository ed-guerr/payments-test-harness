#pragma once

#include <stddef.h>
#include <stdint.h>

#include "pay/message.h"

/*
 * Print the process's MessageDef table as JSON (the `--introspect` mode).
 * Output:
 * {
 *   "process": "pay-orders",
 *   "listen": "127.0.0.1:9101",
 *   "messages": [
 *     {
 *       "id": 10,
 *       "name": "CreatePayment",
 *       "direction": "in",
 *       "size": 27,
 *       "response": 20,
 *       "fields": [ { "name": "txn_id", "type": "uint32_t", "size": 4, "offset": 0 }, ... ]
 *     }, ...
 *   ]
 * }
 * This JSON is the registry the harness/MCP server consume.
 */
void introspect_print(const char *process, uint16_t port, const MessageDef *table, size_t n_msgs);
