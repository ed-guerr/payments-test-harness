# eval — Qwen3.8-27B @ http://<your-lan-gpu-box>:8080/v1

generated 2026-10-13T17:29:33.521Z · 3 run(s)/task · temperature 0 · max 25 tool steps

| config | pass | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) | avg tokens in/out (per run) | avg cost (usd/run) | total tokens in/out | total cost (usd) |
|---|---|---|---|---|---|---|---|---|---|---|
| kb-on | 33/33 | 33/33 | 33/33 | 13.2 | 1 | 13 | 53285 / 1098 | 0.0000 | 1758405 / 36235 | 0.0000 |
| kb-off | 32/33 | 32/33 | 32/33 | 14.6 | 1.3 | 11 | 48993 / 1311 | 0.0000 | 1616765 / 43274 | 0.0000 |

## per-task — kb-on

| task | kb-sensitive | pass | tool calls | wall (s) |
|---|---|---|---|---|
| happy-path |  | 3/3 | 16 | 14 |
| double-settle-rejection |  | 3/3 | 13 | 15 |
| insufficient-funds |  | 3/3 | 8 | 8 |
| cancel-payment |  | 3/3 | 14 | 13 |
| reversal-chain |  | 3/3 | 8 | 10 |
| chaos-kill-ledger |  | 3/3 | 8 | 8 |
| gateway-forward-completes | yes | 3/3 | 13 | 9 |
| settle-moves-money | yes | 3/3 | 21 | 18 |
| settle-then-reverse |  | 3/3 | 16 | 13 |
| unknown-account |  | 3/3 | 7 | 6 |
| interleaved-payments |  | 3/3 | 21 | 22 |

## per-task — kb-off

| task | kb-sensitive | pass | tool calls | wall (s) |
|---|---|---|---|---|
| happy-path |  | 3/3 | 15 | 11 |
| double-settle-rejection |  | 3/3 | 16.3 | 14 |
| insufficient-funds |  | 3/3 | 13 | 9 |
| cancel-payment |  | 3/3 | 11 | 8 |
| reversal-chain |  | 3/3 | 8 | 8 |
| chaos-kill-ledger |  | 3/3 | 9 | 8 |
| gateway-forward-completes | yes | 3/3 | 15 | 10 |
| settle-moves-money | yes | 3/3 | 19.3 | 20 |
| settle-then-reverse |  | 3/3 | 18 | 22 |
| unknown-account |  | 2/3 | 17 | 11 |
| interleaved-payments |  | 3/3 | 19 | 24 |

pass = agent created the suite AND it runs green (independent re-run) AND the full ground-truth checklist is satisfied.
