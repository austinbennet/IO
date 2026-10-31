#!/usr/bin/env bash
# Full server restart recovery: start a lavfi stream, SIGTERM the API, restart it, time until RUNNING again.
set -uo pipefail
B=${BASE:-http://127.0.0.1:8080}
EMAIL=${IO_ADMIN_EMAIL:?}; PASS=${IO_ADMIN_PASSWORD:?}
HERE=$(cd "$(dirname "$0")" && pwd); BE=$HERE/../backend
PASSN=0; FAILN=0
ok(){ PASSN=$((PASSN+1)); echo "PASS  $1"; }; bad(){ FAILN=$((FAILN+1)); echo "FAIL  $1"; }
tok(){ curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))'; }
AT=$(tok); H="Authorization: Bearer $AT"
[ -n "$AT" ] && ok "admin login" || { bad "admin login"; exit 1; }
SLUG="restart-$(date +%s)"
CID=$(curl -s -X POST $B/api/channels -H "$H" -H 'Content-Type: application/json' -d "{\"slug\":\"$SLUG\",\"name\":\"Restart Test\",\"streams\":{\"primary\":{\"sourceType\":\"LAVFI_TEST\",\"sourceUrl\":\"testsrc2\"}}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["channel"]["id"])')
[ -n "$CID" ] && ok "channel created" || { bad "channel created"; exit 1; }
curl -s -o /dev/null -X POST $B/api/streams/$CID/start -H "$H" -H 'Content-Type: application/json' -d '{"source":"PRIMARY"}'
st(){ curl -s $B/api/streams/$CID/status -H "$H" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("state","") if d.get("state")=="RUNNING" else ((d.get("persisted") or {}).get("state") if (d.get("state")!="RUNNING" and (d.get("persisted") or {}).get("state")=="RUNNING") else d.get("state","")))'; }
for i in $(seq 1 60); do [ "$(st)" = RUNNING ] && break; sleep 1; done
[ "$(st)" = RUNNING ] && ok "stream RUNNING before restart" || bad "stream RUNNING before restart"
# Kill the API server (SIGTERM = graceful shutdown), then restart it.
PIDS=$(pgrep -f '[t]sx src/server.ts' || true)
[ -n "$PIDS" ] && kill -TERM $PIDS && echo "sent SIGTERM to: $PIDS" || bad "could not find API server pid"
sleep 1
! curl -s -o /dev/null --max-time 2 $B/healthz && ok "server stopped" || bad "server still answering after SIGTERM"
for i in $(seq 1 30); do curl -s -o /dev/null $B/healthz || break; sleep 1; done
T0=$(date +%s.%N)
(cd $BE && set -a && . ./.env.local && set +a && setsid nohup npx tsx src/server.ts > /tmp/io-restart-server.log 2>&1 < /dev/null &)
for i in $(seq 1 120); do curl -s -o /dev/null $B/healthz && break; sleep 0.5; done
ok "server restarted"
AT=$(tok); H="Authorization: Bearer $AT"
for i in $(seq 1 120); do [ "$(st)" = RUNNING ] && break; sleep 0.5; done
T1=$(date +%s.%N)
if [ "$(st)" = RUNNING ]; then ok "stream auto-restored to RUNNING after server restart"; echo "RECOVERY_MS full_restart=$(python3 -c "print(int(($T1-$T0)*1000))")"; else bad "stream auto-restored after server restart"; fi
curl -s -o /dev/null -X POST $B/api/streams/$CID/stop -H "$H"
echo "RESULT: PASS=$PASSN FAIL=$FAILN"; [ $FAILN -eq 0 ]
