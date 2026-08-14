#!/usr/bin/env bash
set -euo pipefail

xvfb-run -a bash -c '
  set -euo pipefail
  openbox >"${RUNNER_TEMP:-/tmp}/mmd-openbox.log" 2>&1 &
  window_manager_pid=$!
  cleanup() {
    kill "$window_manager_pid" 2>/dev/null || true
    wait "$window_manager_pid" 2>/dev/null || true
  }
  trap cleanup EXIT
  for _ in $(seq 1 100); do
    if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; then
      "$@"
      exit
    fi
    sleep 0.05
  done
  echo "Openbox did not become ready under Xvfb." >&2
  exit 1
' bash "$@"
