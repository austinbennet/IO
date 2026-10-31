#!/usr/bin/env bash
# Streaming resilience test against a running IO backend (real FFmpeg, real HLS, real failover).
# Requires: IO_ADMIN_EMAIL / IO_ADMIN_PASSWORD env vars for an ADMIN user, ALLOW_PRIVATE_SOURCE_HOSTS=127.0.0.1 on the server.
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
IO_DATA_DIR="${IO_DATA_DIR:-/home/user/io/data}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPORT="$HERE/results/streaming-report.txt"
mkdir -p "$HERE/results"
: > "$REPORT"
PASS=0; FAIL=0
log()  { echo "$*" | tee -a "$REPORT"; }
ok()   { PASS=$((PASS+1)); log "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); log "FAIL  $1 -- $2"; }
jget() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
api()  { # method path [body]
  local m=$1 p=$2 b=${3:-}
  if [ -n "$b" ]; then
    curl -s -X "$m" "$BASE$p" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "$b"
  else
    curl -s -X "$m" "$BASE$p" -H "Authorization: Bearer $TOKEN"
  fi
}
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
wait_state() { # channelId wantedJsonExpr timeoutSec -> prints elapsed ms, returns 0 if met
  local id=$1 expr=$2 timeout=$3 t0; t0=$(now_ms)
  while [ $(( $(now_ms) - t0 )) -lt $(( timeout * 1000 )) ]; do
    local st; st=$(api GET "/api/streams/$id/status" | jget "$expr")
    if [ "$st" = "True" ]; then echo $(( $(now_ms) - t0 )); return 0; fi
    sleep 0.5
  done
  echo -1; return 1
}

log "IO streaming resilience test  $(date -u +%FT%TZ)"
log "BASE=$BASE"

TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$IO_ADMIN_EMAIL\",\"password\":\"$IO_ADMIN_PASSWORD\"}" | jget "d['accessToken']")
[ -n "$TOKEN" ] && ok "admin login" || { bad "admin login" "no token"; exit 1; }

# Start from a clean slate: stop any stream left running by earlier tests (they count against MAX_CONCURRENT_STREAMS).
for id in $(api GET /api/streams | python3 -c "import sys,json; print(' '.join(i['channelId'] for i in json.load(sys.stdin)['items'] if i['running']))"); do
  api POST "/api/streams/$id/stop" '{}' > /dev/null
  log "      pre-test: stopped leftover stream $id"
done
sleep 2

STAMP=$(date +%s)
LAV_SLUG="lavfi-$STAMP"; FO_SLUG="failover-$STAMP"
LAV_ID=$(api POST /api/channels "{\"slug\":\"$LAV_SLUG\",\"name\":\"Lavfi Test\",\"status\":\"ACTIVE\",\"streams\":{\"primary\":{\"sourceType\":\"LAVFI_TEST\",\"sourceUrl\":\"testsrc2\"}}}" | jget "d['channel']['id']")
FO_ID=$(api POST /api/channels "{\"slug\":\"$FO_SLUG\",\"name\":\"Failover Test\",\"status\":\"ACTIVE\",\"encodingProfile\":{\"fps\":25},\"streams\":{\"primary\":{\"sourceType\":\"URL\",\"sourceUrl\":\"http://127.0.0.1:9000/live.ts\"},\"backup\":{\"sourceType\":\"LAVFI_TEST\",\"sourceUrl\":\"smptebars\"}}}" | jget "d['channel']['id']")
[ -n "$LAV_ID" ] && [ -n "$FO_ID" ] && ok "channels created (lavfi + primary/backup)" || bad "channels created" "$LAV_ID $FO_ID"

# ---- Origin (simulated live source built from FFmpeg-generated MPEG-TS) ----
python3 "$HERE/media_origin.py" 9000 > "$HERE/results/origin.log" 2>&1 &
ORIGIN_PID=$!
sleep 1
curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/ | grep -q 200 && ok "origin serving live TS on 127.0.0.1:9000" || bad "origin" "not serving"

# ---- 1. Automatic restart after encoder crash ----
api POST "/api/streams/$LAV_ID/start" '{}' > /dev/null
T=$(wait_state "$LAV_ID" "d['live']['state']=='RUNNING'" 30)
[ "$T" -ge 0 ] && ok "lavfi channel RUNNING in ${T} ms" || bad "lavfi channel RUNNING" "timeout"
PID1=$(api GET "/api/streams/$LAV_ID/status" | jget "d['live']['pid']")
sleep 3
kill -9 "$PID1" 2>/dev/null
log "      killed encoder pid=$PID1 (SIGKILL) at $(date -u +%T.%3N)"
T0=$(now_ms)
REC=-1
while [ $(( $(now_ms) - T0 )) -lt 60000 ]; do
  NEWPID=$(api GET "/api/streams/$LAV_ID/status" | jget "d['live']['pid']")
  ST=$(api GET "/api/streams/$LAV_ID/status" | jget "d['live']['state']")
  if [ "$NEWPID" != "None" ] && [ "$NEWPID" != "$PID1" ] && [ "$ST" = "RUNNING" ]; then REC=$(( $(now_ms) - T0 )); break; fi
  sleep 0.25
done
if [ "$REC" -ge 0 ]; then ok "automatic restart after SIGKILL: new pid $NEWPID RUNNING in ${REC} ms"; log "RECOVERY_MS crash_restart=$REC"; else bad "automatic restart" "not recovered"; fi
RC=$(api GET "/api/streams/$LAV_ID/status" | jget "d['persisted']['restart_count']")
log "      restart_count (persisted) = $RC"

# ---- 2. Primary/backup failover on origin outage ----
START_RESP=$(api POST "/api/streams/$FO_ID/start" '{}')
echo "$START_RESP" | grep -q '"error"' && log "      start response: $START_RESP"
T=$(wait_state "$FO_ID" "d['live']['state']=='RUNNING' and d['live']['activeSourceRole']=='PRIMARY'" 60)
[ "$T" -ge 0 ] && ok "primary (origin) RUNNING in ${T} ms" || bad "primary RUNNING" "$(api GET "/api/streams/$FO_ID/status" | head -c 300)"
sleep 6
kill -9 "$ORIGIN_PID" 2>/dev/null
log "      origin killed at $(date -u +%T.%3N)"
T0=$(now_ms); FO=-1; SEEN=""
while [ $(( $(now_ms) - T0 )) -lt 120000 ]; do
  S=$(api GET "/api/streams/$FO_ID/status")
  ST=$(echo "$S" | jget "d['live']['state']")
  RO=$(echo "$S" | jget "d['live']['activeSourceRole']")
  case "$SEEN" in *"$ST/$RO"*) ;; *) SEEN="$SEEN $ST/$RO"; log "      observed state=$ST role=$RO at +$(( $(now_ms) - T0 )) ms";; esac
  if [ "$ST" = "RUNNING" ] && [ "$RO" = "BACKUP" ]; then FO=$(( $(now_ms) - T0 )); break; fi
  sleep 0.5
done
if [ "$FO" -ge 0 ]; then ok "failover to BACKUP source RUNNING in ${FO} ms after origin loss"; log "RECOVERY_MS failover=$FO"; else bad "failover to backup" "states:$SEEN"; fi

EVENTS=$(api GET "/api/system/events?limit=200")
echo "$EVENTS" | grep -q '"FAILOVER"' && ok "FAILOVER recorded in system_events" || bad "FAILOVER event" "missing"
echo "$EVENTS" | grep -q '"STREAM_RESTART"' && ok "STREAM_RESTART recorded in system_events" || bad "STREAM_RESTART event" "missing"

# ---- 3. HLS output is continuously produced during failover ----
MASTER="$IO_DATA_DIR/hls/$FO_SLUG/master.m3u8"
if [ -f "$MASTER" ]; then ok "master.m3u8 exists for failover channel"; else bad "master.m3u8" "missing"; fi
COUNT1=$(ls "$IO_DATA_DIR/hls/$FO_SLUG/360p/" 2>/dev/null | grep -c '\.ts$')
sleep 12
COUNT2=$(ls "$IO_DATA_DIR/hls/$FO_SLUG/360p/" 2>/dev/null | grep -c '\.ts$')
[ "$COUNT2" -ge 1 ] && log "      segments: t0=$COUNT1 t+12s=$COUNT2 (sliding window)" && ok "HLS segments keep being produced after failover" || bad "HLS segment production" "$COUNT2"

# ---- 4. Validate the generated ABR HLS with ffprobe ----
if command -v ffprobe >/dev/null; then
  V=$(ls "$IO_DATA_DIR/hls/$FO_SLUG/360p/"*.ts 2>/dev/null | tail -1)
  if [ -n "$V" ]; then
    INFO=$(ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,sample_rate -of csv=p=0 "$V")
    echo "$INFO" | grep -q 'h264' && echo "$INFO" | grep -q 'aac' && ok "segment probes as H.264 + AAC ($(echo "$INFO" | tr '\n' ' '))" || bad "segment codec probe" "$INFO"
  fi
  VARIANTS=$(grep -c 'EXT-X-STREAM-INF' "$MASTER" 2>/dev/null)
  [ "${VARIANTS:-0}" -ge 2 ] && ok "master playlist declares $VARIANTS ABR variants" || bad "ABR variants" "$VARIANTS"
  grep -q 'EXT-X-PROGRAM-DATE-TIME' "$IO_DATA_DIR/hls/$FO_SLUG/360p/index.m3u8" && ok "playlist has EXT-X-PROGRAM-DATE-TIME" || bad "program-date-time" "missing"
fi

# ---- 5. Stop and verify state ----
api POST "/api/streams/$LAV_ID/stop" '{}' > /dev/null
api POST "/api/streams/$FO_ID/stop" '{}' > /dev/null
T=$(wait_state "$LAV_ID" "d['live']['state']=='STOPPED'" 15); [ "$T" -ge 0 ] && ok "lavfi stream STOPPED" || bad "stop" "lavfi"
T=$(wait_state "$FO_ID" "d['live']['state']=='STOPPED'" 15); [ "$T" -ge 0 ] && ok "failover stream STOPPED" || bad "stop" "failover"

kill "$ORIGIN_PID" 2>/dev/null
log ""
log "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
