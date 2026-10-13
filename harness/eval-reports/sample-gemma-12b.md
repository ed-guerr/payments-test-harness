# eval — gemma-4-12b-it-qat-q4_0.gguf @ http://<your-lan-gpu-box>:8082/v1

generated 2026-10-13T22:36:17.483Z · 3 run(s)/task · temperature 0 · max 25 tool steps

| config | pass | suite green | checklist full | avg tool calls | avg suite runs | p50 wall (s) | tokens in / out | cost (usd) |
|---|---|---|---|---|---|---|---|---|
| kb-on | 12/33 | 21/33 | 15/33 | 14.4 | 0.9 | 14 | 2875205 / 84316 | n/a |
| kb-off | 8/33 | 14/33 | 8/33 | 18.1 | 0.8 | 50 | 3179911 / 136026 | n/a |

## per-task — kb-on

| task | kb-sensitive | pass | tool calls | wall (s) |
|---|---|---|---|---|
| happy-path |  | 0/3 | 7 | 11 |
| double-settle-rejection |  | 0/3 | 25 | 67 |
| insufficient-funds |  | 0/3 | 6.7 | 8 |
| cancel-payment |  | 0/3 | 25 | 63 |
| reversal-chain |  | 0/3 | 25 | 21 |
| chaos-kill-ledger |  | 3/3 | 6 | 9 |
| gateway-forward-completes | yes | 3/3 | 15 | 14 |
| settle-moves-money | yes | 0/3 | 25 | 62 |
| settle-then-reverse |  | 0/3 | 8.7 | 15 |
| unknown-account |  | 3/3 | 8 | 9 |
| interleaved-payments |  | 3/3 | 7 | 12 |

## per-task — kb-off

| task | kb-sensitive | pass | tool calls | wall (s) |
|---|---|---|---|---|
| happy-path |  | 0/3 | 25 | 51 |
| double-settle-rejection |  | 0/3 | 25 | 69 |
| insufficient-funds |  | 0/3 | 7 | 8 |
| cancel-payment |  | 0/3 | 25 | 63 |
| reversal-chain |  | 3/3 | 6 | 8 |
| chaos-kill-ledger |  | 3/3 | 7.7 | 13 |
| gateway-forward-completes | yes | 2/3 | 20 | 20 |
| settle-moves-money | yes | 0/3 | 25 | 61 |
| settle-then-reverse |  | 0/3 | 25 | 62 |
| unknown-account |  | 0/3 | 8 | 11 |
| interleaved-payments |  | 0/3 | 25 | 61 |

## regression gate

- kb-on: no baseline (not gated) — got 12/33
- kb-off: no baseline (not gated) — got 8/33
- skipped: kb-on: no baseline
- skipped: kb-off: no baseline

pass = agent created the suite AND it runs green (independent re-run) AND the full ground-truth checklist is satisfied.
