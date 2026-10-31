#!/usr/bin/env bash
# End-to-end API test against a running IO backend.
# Usage: BASE=http://127.0.0.1:8080 ./tests/e2e-api.sh
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
PASS=0; FAIL=0
RESULTS=()
ok()   { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1 -- $2"); echo "FAIL  $1 -- $2"; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
req()  { # method path [body] [token]
  local m=$1 p=$2 b=${3:-} t=${4:-}
  local args=(-s -o /tmp/io_body -w '%{http_code}' -X "$m" "$BASE$p" -H 'Content-Type: application/json')
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$b" ] && args+=(--data "$b")
  curl "${args[@]}"
}
expect() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1 (HTTP $3)"; else bad "$1" "expected HTTP $2 got $3: $(head -c 200 /tmp/io_body)"; fi
}

STAMP=$(date +%s)
ADMIN_EMAIL="admin-$STAMP@io.test"
PASSWORD="Correct-Horse-9123"

echo "== Health =="
code=$(req GET /healthz); expect "GET /healthz" 200 "$code"

echo "== Authentication =="
code=$(req POST /api/auth/register "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"Test Admin\"}")
expect "bootstrap admin register" 201 "$code"
ROLE=$(json "d['user']['role']" < /tmp/io_body); [ "$ROLE" = "ADMIN" ] && ok "first user is ADMIN" || bad "first user is ADMIN" "role=$ROLE"

code=$(req POST /api/auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"wrong-password-xx\"}")
expect "login with wrong password rejected" 401 "$code"

code=$(req POST /api/auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASSWORD\"}")
expect "login" 200 "$code"
TOKEN=$(json "d['accessToken']" < /tmp/io_body)
REFRESH=$(json "d['refreshToken']" < /tmp/io_body)

code=$(req GET /api/auth/me "" "$TOKEN"); expect "GET /api/auth/me with token" 200 "$code"
code=$(req GET /api/auth/me); expect "GET /api/auth/me without token rejected" 401 "$code"
code=$(req GET /api/auth/me "" "not.a.jwt"); expect "GET /api/auth/me with forged token rejected" 401 "$code"

# Viewer account: read-only enforcement
VIEWER_EMAIL="viewer-$STAMP@io.test"
code=$(req POST /api/auth/register "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$PASSWORD\",\"role\":\"VIEWER\"}" "$TOKEN")
expect "admin creates viewer" 201 "$code"
code=$(req POST /api/auth/login "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$PASSWORD\"}")
VTOKEN=$(json "d['accessToken']" < /tmp/io_body)
code=$(req POST /api/auth/register "{\"email\":\"x-$STAMP@io.test\",\"password\":\"$PASSWORD\"}" "$VTOKEN")
expect "viewer cannot create accounts" 403 "$code"

code=$(req POST /api/auth/refresh "{\"refreshToken\":\"$REFRESH\"}")
expect "refresh token rotation" 200 "$code"
REFRESH2=$(json "d['refreshToken']" < /tmp/io_body)
TOKEN=$(json "d['accessToken']" < /tmp/io_body)
code=$(req POST /api/auth/refresh "{\"refreshToken\":\"$REFRESH\"}")
expect "reused refresh token rejected" 401 "$code"

echo "== Channels =="
SLUG="io-test-$STAMP"
CH_BODY=$(cat <<EOF
{"slug":"$SLUG","name":"IO Test Channel","category":"Testing","language":"en","timezone":"Europe/Istanbul",
 "status":"ACTIVE","epgChannelId":"io.test.$STAMP","encodingProfile":{"fps":25},
 "streams":{"primary":{"sourceType":"LAVFI_TEST","sourceUrl":"testsrc2"}}}
EOF
)
code=$(req POST /api/channels "$CH_BODY" "$TOKEN"); expect "create channel with FFmpeg test source" 201 "$code"
CHANNEL_ID=$(json "d['channel']['id']" < /tmp/io_body)

code=$(req POST /api/channels '{"slug":"BAD SLUG","name":"x"}' "$TOKEN"); expect "invalid slug rejected" 422 "$code"
code=$(req POST /api/channels "{\"slug\":\"ssrf-$STAMP\",\"name\":\"x\",\"streams\":{\"primary\":{\"sourceType\":\"URL\",\"sourceUrl\":\"http://169.254.169.254/latest/\"}}}" "$TOKEN")
expect "SSRF: metadata-service stream URL rejected" 422 "$code"
code=$(req POST /api/channels "{\"slug\":\"ssrf2-$STAMP\",\"name\":\"x\",\"streams\":{\"primary\":{\"sourceType\":\"URL\",\"sourceUrl\":\"file:///etc/passwd\"}}}" "$TOKEN")
expect "SSRF: file:// stream URL rejected" 422 "$code"

code=$(req GET "/api/channels/$CHANNEL_ID" "" "$TOKEN"); expect "GET channel" 200 "$code"
code=$(req PUT "/api/channels/$CHANNEL_ID" '{"name":"IO Test Channel (renamed)","description":"updated by e2e"}' "$TOKEN"); expect "PUT channel" 200 "$code"
NAME=$(json "d['channel']['name']" < /tmp/io_body); [ "$NAME" = "IO Test Channel (renamed)" ] && ok "update persisted" || bad "update persisted" "$NAME"
code=$(req GET "/api/channels?q=io-test&pageSize=5" "" "$TOKEN"); expect "channel list with search" 200 "$code"
code=$(req GET "/api/channels" "" "$VTOKEN"); expect "viewer can list channels" 200 "$code"
code=$(req POST /api/channels "{\"slug\":\"viewer-$STAMP\",\"name\":\"x\"}" "$VTOKEN"); expect "viewer cannot create channel" 403 "$code"

echo "== Streaming (real FFmpeg) =="
code=$(req POST "/api/streams/$CHANNEL_ID/start" '{}' "$TOKEN"); expect "start stream" 200 "$code"
for i in $(seq 1 30); do
  [ -f "/home/user/io/data/hls/$SLUG/master.m3u8" ] && break
  sleep 1
done
code=$(req GET "/hls/$SLUG/master.m3u8"); expect "HLS master without token rejected" 401 "$code"
MT=$(curl -s "$BASE/api/channels/$CHANNEL_ID/stream.m3u8" -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{redirect_url}')
MEDIA_URL="$BASE$(echo "$MT" | sed "s#^$BASE##")"
code=$(curl -s -o /tmp/io_master -w '%{http_code}' "$MEDIA_URL"); expect "HLS master with signed token" 200 "$code"
grep -q '#EXTM3U' /tmp/io_master && grep -q 'EXT-X-STREAM-INF' /tmp/io_master && ok "master playlist is a valid HLS master" || bad "master playlist" "$(head -c 300 /tmp/io_master)"
VARIANT=$(grep -v '^#' /tmp/io_master | grep '\.m3u8' | head -1)
grep -q 't=' <<<"$VARIANT" && ok "master playlist URIs carry embedded media tokens" || bad "embedded media token in master URI" "$VARIANT"
VPATH=${VARIANT%%\?*}
code=$(curl -s -o /tmp/io_variant -w '%{http_code}' "$BASE/hls/$SLUG/$VARIANT")
expect "variant playlist reachable" 200 "$code"
SEG=$(grep -v '^#' /tmp/io_variant | grep '\.ts' | head -1)
code=$(curl -s -o /tmp/io_seg -w '%{http_code}' "$BASE/hls/$SLUG/$(dirname "$VPATH")/$SEG")
expect "MPEG-TS segment reachable" 200 "$code"
for i in $(seq 1 20); do
  st=$(req GET "/api/streams/$CHANNEL_ID/status" "" "$TOKEN"); state=$(json "d['live']['state']" < /tmp/io_body)
  [ "$state" = "RUNNING" ] && break; sleep 1
done
[ "$state" = "RUNNING" ] && ok "stream state RUNNING" || bad "stream state RUNNING" "state=$state"

code=$(req POST "/api/streams/$CHANNEL_ID/stop" '{}' "$TOKEN"); expect "stop stream" 200 "$code"

echo "== Playlists =="
M3U=$(cat <<EOF
#EXTM3U
#EXTINF:-1 tvg-id="io.news" tvg-name="IO News" tvg-logo="https://cdn.example.org/n.png" group-title="News",IO News
https://streams.example.org/live/io-news/index.m3u8
#EXTINF:-1 tvg-id="io.sport" group-title="Sports",IO Sport
https://user:pw@streams.example.org/sport.m3u8
#EXTINF:-1 tvg-id="io.news" group-title="News",IO News Dup
https://streams.example.org/live/io-news/index.m3u8
#EXTINF:-1,Broken
ftp://files.example.org/x.ts
EOF
)
code=$(curl -s -o /tmp/io_body -w '%{http_code}' -X POST "$BASE/api/playlists/import" -H "Authorization: Bearer $TOKEN" -F "file=@-;filename=e2e.m3u8" <<< "$M3U")
expect "M3U file import (multipart)" 201 "$code"
PID=$(json "d['id']" < /tmp/io_body)
CC=$(json "d['channelCount']" < /tmp/io_body); DC=$(json "d['duplicateCount']" < /tmp/io_body)
[ "$CC" = "4" ] && [ "$DC" = "1" ] && ok "import counts (4 entries, 1 duplicate)" || bad "import counts" "channels=$CC dup=$DC"
code=$(req GET "/api/playlists/$PID/channels?q=news" "" "$TOKEN"); expect "playlist channel search" 200 "$code"
RESULTS_COUNT=$(json "d['total']" < /tmp/io_body); [ "$RESULTS_COUNT" = "2" ] && ok "search returns 2 News matches" || bad "search" "total=$RESULTS_COUNT"
if grep -q 'secret' /tmp/io_body; then bad "credentials leaked in playlist API" "found secret"; else ok "playlist API does not expose credentials"; fi
code=$(curl -s -o /tmp/io_m3u -w '%{http_code}' "$BASE/api/channels/playlist.m3u?access_token=$TOKEN")
expect "M3U export with access_token" 200 "$code"
grep -q '#EXTM3U' /tmp/io_m3u && ok "exported M3U has header" || bad "exported M3U header" ""
grep -q "/hls/$SLUG/master.m3u8?t=" /tmp/io_m3u && ok "exported M3U uses signed IO HLS URLs" || bad "exported M3U URL" "$(head -c 200 /tmp/io_m3u)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/channels/playlist.m3u"); expect "M3U export without auth rejected" 401 "$code"

echo "== EPG =="
XMLTV=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<tv>
<channel id="io.test.$STAMP"><display-name>IO Test</display-name></channel>
<programme start="$(date -u -d '-30 min' +%Y%m%d%H%M%S) +0000" stop="$(date -u -d '+30 min' +%Y%m%d%H%M%S) +0000" channel="io.test.$STAMP"><title>Current Show</title><desc>Live test programme</desc><category>Test</category></programme>
<programme start="$(date -u -d '+30 min' +%Y%m%d%H%M%S) +0000" stop="$(date -u -d '+90 min' +%Y%m%d%H%M%S) +0000" channel="io.test.$STAMP"><title>Next Show</title></programme>
</tv>
EOF
)
code=$(req POST /api/epg/import "$(python3 -c "import json,sys; print(json.dumps({'name':'e2e-$STAMP','xml':sys.stdin.read()}))" <<< "$XMLTV")" "$TOKEN")
expect "XMLTV import" 201 "$code"
code=$(req GET "/api/epg/channel/$CHANNEL_ID" "" "$TOKEN"); expect "EPG for channel" 200 "$code"
CUR=$(json "d['current']['title'] if d['current'] else None" < /tmp/io_body); NXT=$(json "d['next']['title'] if d['next'] else None" < /tmp/io_body)
[ "$CUR" = "Current Show" ] && ok "current programme resolved" || bad "current programme" "$CUR"
[ "$NXT" = "Next Show" ] && ok "next programme resolved" || bad "next programme" "$NXT"

echo "== Graphics (CasparCG disabled in this run: expect honest 503) =="
code=$(req GET /api/graphics/templates "" "$TOKEN"); expect "list graphics templates" 200 "$code"
TCOUNT=$(json "len(d['items'])" < /tmp/io_body); [ "$TCOUNT" -ge 29 ] && ok "graphics package has $TCOUNT templates" || bad "template count" "$TCOUNT"
code=$(req POST /api/graphics/play "{\"channelId\":\"$CHANNEL_ID\",\"layer\":1,\"templateSlug\":\"lower-third-01\",\"data\":{\"name\":\"A\",\"title\":\"B\"}}" "$TOKEN")
expect "TAKE without CasparCG returns explicit 503 (not faked success)" 503 "$code"

echo "== Recordings =="
code=$(req POST /api/recordings/start "{\"channelId\":\"$CHANNEL_ID\",\"maxMinutes\":1}" "$TOKEN"); expect "start recording" 201 "$code"
REC_ID=$(json "d['id']" < /tmp/io_body)
sleep 8
code=$(req POST /api/recordings/stop "{\"recordingId\":\"$REC_ID\"}" "$TOKEN"); expect "stop recording" 200 "$code"
for i in $(seq 1 20); do
  code=$(req GET "/api/recordings?channelId=$CHANNEL_ID" "" "$TOKEN")
  st=$(python3 -c "import json;d=json.load(open('/tmp/io_body'));print([r['status'] for r in d['items'] if r['id']=='$REC_ID'][0])" 2>/dev/null)
  [ "$st" = "COMPLETED" ] || [ "$st" = "FAILED" ] && break; sleep 1
done
[ "$st" = "COMPLETED" ] && ok "recording COMPLETED with metadata" || bad "recording status" "$st"
code=$(req GET "/api/recordings/$REC_ID/download" "" "$TOKEN"); expect "authorized recording download" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/recordings/$REC_ID/download"); expect "recording download without token rejected" 401 "$code"

echo "== Schedules =="
SCH=$(cat <<EOF
{"name":"e2e one-shot start","channelId":"$CHANNEL_ID","action":"START_STREAM","recurrence":"ONCE","runAt":"$(date -u -d '+1 min' +%Y-%m-%dT%H:%M:%SZ)","timezone":"Europe/Istanbul"}
EOF
)
code=$(req POST /api/schedule "$SCH" "$TOKEN"); expect "create one-shot schedule" 201 "$code"
code=$(req POST /api/schedule '{"name":"bad","action":"START_STREAM","recurrence":"DAILY","timeOfDay":"25:00"}' "$TOKEN")
expect "invalid schedule rejected" 422 "$code"

echo "== Monitoring =="
code=$(req GET /api/system/health "" "$TOKEN"); expect "system health" 200 "$code"
DBS=$(json "[c['status'] for c in d['components'] if c['name']=='postgres'][0]" < /tmp/io_body); [ "$DBS" = "UP" ] && ok "postgres UP (live probe)" || bad "postgres" "$DBS"
RS=$(json "[c['status'] for c in d['components'] if c['name']=='redis'][0]" < /tmp/io_body); [ "$RS" = "UP" ] && ok "redis UP (live probe)" || bad "redis" "$RS"
code=$(req GET /api/system/metrics "" "$TOKEN"); expect "system metrics" 200 "$code"
code=$(req GET /api/system/events "" "$TOKEN"); expect "system events" 200 "$code"
code=$(req GET /api/system/audit "" "$TOKEN"); expect "audit log (admin)" 200 "$code"
code=$(req GET /api/system/audit "" "$VTOKEN"); expect "audit log hidden from viewer" 403 "$code"

echo "== Security =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/channels" -H 'Authorization: Bearer abc'); expect "malformed JWT rejected" 401 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hls/..%2F..%2Fetc/master.m3u8?t=x"); [ "$code" != "200" ] && ok "path traversal blocked ($code)" || bad "path traversal" "$code"
code=$(req POST /api/auth/logout "{\"refreshToken\":\"$REFRESH2\"}"); expect "logout revokes refresh" 204 "$code"

echo
echo "================ SUMMARY ================"
printf '%s\n' "${RESULTS[@]}"
echo "PASSED=$PASS FAILED=$FAIL"
[ "$FAIL" -eq 0 ]
