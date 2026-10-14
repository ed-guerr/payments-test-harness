# eval — gpt-6-luna @ https://api.openai.com/v1

generated 2026-10-14T03:58:18.736Z · 3 run(s)/task · temperature 0 · max 25 tool steps

| config | pass | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) | tokens in / out | cost (usd) |
|---|---|---|---|---|---|---|---|---|
| kb-on | 20/33 | 30/33 | 20/33 | 13.7 | 1.1 | 13 | 1164849 / 26702 | 0.1298 |
| kb-off | 22/33 | 28/33 | 22/33 | 22.2 | 1.1 | 19 | 1917879 / 31503 | 0.2076 |

## per-task — kb-on

| task | kb-sensitive | pass | tool calls | wall (s) |
|---|---|---|---|---|
| happy-path |  | 0/3 | 16.3 | 15 |
| double-settle-rejection |  | 1/3 | 13.7 | 304 |
| insufficient-funds |  | 3/3 | 14 | 14 |
| cancel-payment |  | 2/3 | 12.7 | 11 |
| reversal-chain |  | 2/3 | 10.7 | 14 |
| chaos-kill-ledger |  | 0/3 | 13 | 16 |
| gateway-forward-completes | yes | 3/3 | 13.3 | 10 |
| settle-moves-money | yes | 3/3 | 17.7 | 15 |
| settle-then-reverse |  | 3/3 | 14.3 | 11 |
| unknown-account |  | 3/3 | 8.3 | 8 |
| interleaved-payments |  | 0/3 | 16.3 | 19 |

## per-task — kb-off

| task | kb-sensitive | pass | tool calls | wall (s) |
|---|---|---|---|---|
| happy-path |  | 1/3 | 29.7 | 34 |
| double-settle-rejection |  | 2/3 | 21 | 19 |
| insufficient-funds |  | 3/3 | 18.3 | 24 |
| cancel-payment |  | 3/3 | 23.7 | 16 |
| reversal-chain |  | 3/3 | 14 | 13 |
| chaos-kill-ledger |  | 0/3 | 18.3 | 15 |
| gateway-forward-completes | yes | 1/3 | 30.3 | 36 |
| settle-moves-money | yes | 2/3 | 21.7 | 30 |
| settle-then-reverse |  | 3/3 | 28 | 23 |
| unknown-account |  | 3/3 | 11.3 | 16 |
| interleaved-payments |  | 1/3 | 28 | 22 |

## regression gate

- kb-on: no baseline (not gated) — got 20/33
- kb-off: no baseline (not gated) — got 22/33
- skipped: kb-on: no baseline
- skipped: kb-off: no baseline

pass = agent created the suite AND it runs green (independent re-run) AND the full ground-truth checklist is satisfied.
