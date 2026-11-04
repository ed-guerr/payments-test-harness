# The 6-minute demo

Timed script for showing the system live (moved out of the README in the
2026-11 README cut). Quick version: the half-speed GIF in the README; step 5
is the part it plays live.

1. **0:00 Build & introspect.** `make -C backend && npm run gen:registry`.
   The line to say: "the registry is generated from the C function-pointer
   tables, not written."
2. **0:45 Protocol Registry tab.** Three processes live; open the tab: every
   message, field, type, size, and packed offset, all of it introspected.
3. **1:45 Happy path.** Run `payment-happy-path` in the app: live step
   timeline, 10/10 green, DB balances validated (400000 / 300000 / 1050000
   cents), forwards visible in the log feed.
4. **3:00 Failure demo.** Run `assertion-failure-demo`: a step fails with an
   expected-vs-actual diff; the run continues and reports the failure.
5. **4:00 Agent-authored test.** In any MCP client: *"make a test that
   verifies an external authorization completes a payment"*: the agent calls
   `kb_search`, reads `knowledge/backend/auth_gateway.md` ("on approve →
   forwards `CompletePayment`"), and the generated suite contains the
   downstream `dbAssert` a schema-only agent misses → `run_suite` green,
   suite visible in the app.
6. **5:15 Designer.** `npm run design -- "add a refund message that reverses a
   settled payment"`: design doc with X-macro list, handler sketch, and risks
   citing `knowledge/backend/ledger.md`.
