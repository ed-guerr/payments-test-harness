#!/usr/bin/env bash
# Start all three backend processes for manual use.
# The Electron harness spawns its own processes; this script is for humans.
#
#   make run     # starts the processes (logs in build/, pids in build/run.pid)
#   make stop    # stops them
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
export PAY_DB="${PAY_DB:-$ROOT/harness/data/payments.db}"
mkdir -p "$(dirname "$PAY_DB")" build

if [ ! -f "$PAY_DB" ]; then
    echo "initializing database at $PAY_DB"
    sqlite3 "$PAY_DB" < db/schema.sql
fi

./build/pay-orders --db "$PAY_DB" --port 9101 2> build/pay-orders.log &
P1=$!
./build/ledger --db "$PAY_DB" --port 9102 2> build/ledger.log &
P2=$!
./build/auth-gateway --db "$PAY_DB" --port 9103 --orders-port 9101 --ledger-port 9102 \
    2> build/auth-gateway.log &
P3=$!

echo "$P1 $P2 $P3" > build/run.pid
echo "pay-orders   :9101 pid=$P1"
echo "ledger       :9102 pid=$P2"
echo "auth-gateway :9103 pid=$P3 (logs: build/*.log)"

trap 'kill $P1 $P2 $P3 2>/dev/null || true; exit 0' INT TERM
wait
