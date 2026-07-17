#!/bin/bash
# Live regression battery: 16 one-shot coding requests against the REAL
# ChatMinerva model, graded by executing the artifacts it produces.
#
#   bash scripts/battery.sh            # run all cases
#   bash scripts/battery.sh t03 t15    # run a subset
#
# Requirements: `npm run build` first, and saved credentials (`minervacode
# login`). Each case runs `dist/index.js --auto` in a fresh scratch dir;
# auto mode reverts unverified runs and exits nonzero, so the exit column
# is the CLI's own honesty signal. exit=0 means "verified", exit=1 an
# honest failure with rollback — a WRONG artifact behind exit=0 is the bug
# class this battery exists to catch, so always read the smoke-grade table.
#
# This hits the live model: ~15-60s per case, model answers vary between
# runs. Not for the unit-test CI job — run it manually or nightly.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${MINERVACODE_BIN:-${MINERVACLI_BIN:-$REPO/dist/index.js}}"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/minervacode-battery.XXXXXX")"
RESULTS="$BASE/results.txt"
: > "$RESULTS"

if [ ! -f "$CLI" ]; then
  echo "error: $CLI not found — run 'npm run build' first" >&2
  exit 2
fi
echo "scratch: $BASE"

# macOS has no `timeout` binary — bounded wait with a watchdog.
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  return $rc
}

run_case() {
  local id="$1" prompt="$2"
  if [ -n "${SELECTED:-}" ]; then
    case " $SELECTED " in
      *" $id "*) ;;
      *) return ;;
    esac
  fi
  local dir="$BASE/$id"
  mkdir -p "$dir"
  seed_"$id" "$dir" 2>/dev/null
  local start; start=$(date +%s)
  run_with_timeout 360 node "$CLI" --auto --project-dir "$dir" "$prompt" > "$BASE/$id.log" 2>&1
  local rc=$? end; end=$(date +%s)
  local files; files=$(cd "$dir" && ls -p 2>/dev/null | grep -v / | tr '\n' ' ')
  printf '%s exit=%s time=%ss files=[%s]\n' "$id" "$rc" "$((end-start))" "$files" | tee -a "$RESULTS"
}

# ---- seeds (only cases that need pre-existing files) ----
seed_t04() {
  printf 'def add(a, b):\n    return a - b\n' > "$1/calc.py"
  printf 'from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n' > "$1/test_calc.py"
}
seed_t05() { printf 'def double(n):\n    return n * 2\n' > "$1/utils.py"; }
seed_primes_main() {
  cat > "$1/main.py" <<'EOF'
def is_prime(n):
    if n < 2:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True

count = 0
num = 2
while count < 10:
    if is_prime(num):
        print(num)
        count += 1
    num += 1
EOF
}
seed_t07() { seed_primes_main "$1"; }
seed_t09() { seed_primes_main "$1"; }
seed_t11() { printf 'def greet():\n    print(f"Ciao {name}!")\n\ngreet()\n' > "$1/greet.py"; }
seed_t12() { printf 'def add(a, b):\n    return a + b\n\nprint(add(1, 2))\n' > "$1/calc.py"; }
seed_t13() { printf 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n' > "$1/calc.py"; }
seed_t15() { seed_primes_main "$1"; printf 'print("hello")\n' > "$1/greet.py"; }

SELECTED="$*"

run_case t01 "Write a Python script primes.py that prints the first 20 prime numbers."
run_case t02 "Write me a script that greets me and tells me today's date."
run_case t03 "Chiedi all'utente di inserire tre numeri, dopodiché verifica qual è il più piccolo e sommali."
run_case t04 "Fix the bug in calc.py so the tests pass."
run_case t05 "Add a function is_even(n) to utils.py that returns True for even numbers."
run_case t06 "Scrivi uno script fizzbuzz.py che stampa FizzBuzz da 1 a 50."
run_case t07 "Extend main.py to print the first 20 prime numbers instead of 10."
run_case t08 "Write fibonacci.c that prints the first 10 Fibonacci numbers and run it."
run_case t09 "Explain what main.py does."
run_case t10 "Write a script that asks for a name and prints Hello followed by the name."
run_case t11 "Correggi l'errore in greet.py."
run_case t12 "Rename the function add to sum_two in calc.py and update its callers."
run_case t13 "Write tests for calc.py in test_calc.py."
run_case t14 "Make a script countdown.py that counts down from 10 to 1 printing each number."
run_case t15 "Chiedi all'utente un numero e stampa la sua tabellina fino a 10."
run_case t16 "Create shapes.py with functions area_circle(r) and area_square(s) and print area_circle(2)."

# ---- smoke-grade every produced python artifact by RUNNING it ----
echo
echo "── artifact smoke grades (run_exit != 0 or empty output on a print task = investigate)"
find "$BASE" -maxdepth 2 -name '*.py' | sort | while read -r f; do
  rel="${f#"$BASE"/}"
  dir="$(dirname "$f")"
  # t03 explicitly allows a single space-separated input line. Feeding one
  # number per line makes a correct input().split() solution look broken.
  if [ "$rel" = "t03/main.py" ]; then
    out=$(cd "$dir" && printf '9 4 2\n' | python3 "$(basename "$f")" 2>&1 | head -2 | tr '\n' '|')
    (cd "$dir" && printf '9 4 2\n' | python3 "$(basename "$f")" >/dev/null 2>&1)
  else
    out=$(cd "$dir" && yes 2 | head -20 | python3 "$(basename "$f")" 2>&1 | head -2 | tr '\n' '|')
    (cd "$dir" && yes 2 | head -20 | python3 "$(basename "$f")" >/dev/null 2>&1)
  fi
  rc=$?
  printf '  %-28s run_exit=%s  %s\n' "$rel" "$rc" "$out"
done

echo
echo "results: $RESULTS   logs: $BASE/*.log"
