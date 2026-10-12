# backend — guide index

- **[common.md](./common.md)** — Shared plumbing for all three backend processes: the wire codec (fixed 8-byte little-endian envelope), the TCP listener with a function-pointer dispatch table, the introspection emitter that powers the registry, SQLite helpers, logging, and argument parsing.
- **[pay_orders.md](./pay_orders.md)** — Payment lifecycle owner.
- **[ledger.md](./ledger.md)** — Double-entry ledger.
- **[auth_gateway.md](./auth_gateway.md)** — External boundary for authorization and settlement.
