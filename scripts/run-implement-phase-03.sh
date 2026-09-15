#!/usr/bin/env bash
# scripts/run-implement-phase-03.sh — repo-root, runs on HOST (not in any container)
set -euo pipefail

REPETICOES="${1:-2}"

for i in $(seq 1 "$REPETICOES"); do
  echo "=== Execução $i/$REPETICOES ==="
  claude -p "/implement phase-03-videos"
done
