#!/usr/bin/env bash
# Deployed-stack restart: start a FFmpeg channel through nginx, `docker restart` the API container,
# and time how long until the stream is RUNNING again (boot-time restore of desired_state).
set -uo pipefail
B=${BASE:-http://127.0.0.1}
EMAIL=${IO_ADMIN_EMAIL:?}; PASS=${IO_ADMIN_PASSWORD:?}
CT=${API_CONTAINER:-io-broadcast-io-api-1}
P=0; F=0; ok(){ P=$((P+1)); echo "PASS  $1"; }; bad(){ F=$((F+1)); echo "FAIL  $1"; }
login(){ curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))'; }
AT=$(login); H="Authorization: Bearer $AT"
[ -n "$AT" ] && ok "login via nginx" || { bad "login"; exit 1; }
# Free concurrency slots (MAX_CONCURRENT_STREAMS) held by leftovers from earlier test runs.
for id in $(curl -s $B/api/streams -H "$H" | python3 -c 'import sys,json;[print(i["channelId"]) for i in json.load(sys.stdin)["items"] if i.get("running")]'); do curl -s -o /dev/null -X POST $B/api/streams/$id/stop -H "$H"; done
sleep 3
SLUG="dock-restart-$(date +%s)"
CID=$(curl -s -X POST $B/api/channels -H "$H" -H 'Content-Type: application/json' -d "{\"slug\":\"$SLUG\",\"name\":\"Docker Restart\",\"status\":\"ACTIVE\",\"streams\":{\"primary\":{\"sourceType\":\"LAVFI_TEST\",\"sourceUrl\":\"testsrc2\"}}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["channel"]["id"])')
st(){ curl -s $B/api/streams/$CID/status -H "$H" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("live") or {}).get("state") or (d.get("persisted") or {}).get("state") or "")'; }
curl -s -o /dev/null -X POST $B/api/streams/$CID/start -H "$H" -H 'Content-Type: application/json' -d '{"source":"PRIMARY"}'
for i in $(seq 1 90); do [ "$(st)" = RUNNING ] && break; sleep 1; done
[ "$(st)" = RUNNING ] && ok "stream RUNNING before container restart" || bad "stream RUNNING before restart"
T0=$(date +%s%N)
sudo docker restart $CT >/dev/null && ok "container $CT restarted"
for i in $(seq 1 240); do curl -sf -m 2 -o /dev/null $B/healthz && break; sleep 0.5; done
for i in $(seq 1 60); do AT=$(login); [ -n "$AT" ] && break; sleep 1; done; H="Authorization: Bearer $AT"
for i in $(seq 1 180); do [ "$(st)" = RUNNING ] && break; sleep 0.5; done
T1=$(date +%s%N)
if [ "$(st)" = RUNNING ]; then ok "stream auto-restored to RUNNING after container restart"; echo "RECOVERY_MS docker_restart=$(( (T1-T0)/1000000 ))"; else bad "stream auto-restored after container restart"; fi
curl -s -o /dev/null -X POST $B/api/streams/$CID/stop -H "$H"
echo "RESULT: PASS=$P FAIL=$F"; [ $F -eq 0 ]
