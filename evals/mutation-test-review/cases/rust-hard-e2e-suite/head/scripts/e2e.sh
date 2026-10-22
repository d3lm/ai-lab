#!/usr/bin/env bash
# End-to-end checks for the slugtool binary. Run by `make test` in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -q
BIN=${CARGO_TARGET_DIR:-target}/debug/slugtool

check() {
  local max=$1 input=$2 want=$3 got
  got=$(printf '%s\n' "$input" | "$BIN" "$max")
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: slugify($input, $max) = '$got', want '$want'" >&2
    exit 1
  fi
}

check 64 "Hello World" "hello-world"
check 64 "  Rust's   2024 Edition!  " "rusts-2024-edition"
check 64 "--- ???" ""
# word-boundary truncation
check 11 "hello world again" "hello-world"
check 10 "hello world again" "hello"
check 3 "hello" ""
echo "e2e ok"
