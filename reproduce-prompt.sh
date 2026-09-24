#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if [[ "$ROOT" == *Code6-25-B* ]]; then
  STATE_DIR="$HOME/.cache/code6-25-b"
else
  STATE_DIR="$HOME/.cache/code6-25-a"
fi
API_BASE="${API_BASE_URL:-$(cat "$STATE_DIR/api-url")}"

for _ in {1..100}; do
  curl -fsS "$API_BASE/health/live" >/dev/null 2>&1 && break
  sleep 0.1
done

created="$(curl -fsS -X POST "$API_BASE/api/v1/tours" -H 'Content-Type: application/json' -d '{"name":"录制剧团","seed":42}')"
tour_id="$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).tour.id))')"
[[ -n "$tour_id" ]] || { echo "failed to create tour" >&2; exit 1; }

investigated="$(curl -fsS -X POST "$API_BASE/api/v1/tours/$tour_id/investigations" -H 'Content-Type: application/json' -d '{"kind":"tavern"}')"
status_before="$(printf '%s' "$investigated" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).tour.status))')"
[[ "$status_before" == "PREPARING" ]] || { echo "unexpected state before restart: $status_before" >&2; exit 1; }

echo "tour id: $tour_id"
echo "immediate restart requested after successful investigation"
old_pid="$(cat "$STATE_DIR/api.pid")"
touch "$STATE_DIR/restart-request"
kill -TERM "$old_pid"

new_pid=""
for _ in {1..150}; do
  candidate="$(cat "$STATE_DIR/api.pid" 2>/dev/null || true)"
  if [[ -n "$candidate" && "$candidate" != "$old_pid" ]] && kill -0 "$candidate" 2>/dev/null && curl -fsS "$API_BASE/health/live" >/dev/null 2>&1; then
    new_pid="$candidate"
    break
  fi
  sleep 0.1
done
[[ -n "$new_pid" ]] || { echo "API did not restart" >&2; exit 1; }

after="$(curl -fsS "$API_BASE/api/v1/tours/$tour_id")"
printf '%s' "$after" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const tour=JSON.parse(s).tour;
  const clues=Object.values(tour.clues||{}).flat().length;
  console.log(`after restart: status=${tour.status} version=${tour.version} clues=${clues}`);
  if (tour.status!=="PREPARING" || Number(tour.version)<2 || clues<1) process.exit(1);
})'

node -e '
const save=require("./data.json");
if(!Number.isInteger(save.generation)||typeof save.checksum!=="string"||save.checksum.length!==64) process.exit(1);
console.log(`save envelope: generation=${save.generation} checksum=${save.checksum.slice(0,12)}...`);
'
test -f data.json.bak
printf '%s\n' "$tour_id" >"$STATE_DIR/tour-id"
echo "RESTART_AFTER_SUCCESS PASS"
