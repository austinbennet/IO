#!/usr/bin/env bash
# Deployed-stack check: through nginx only, create a FFmpeg test channel, start it, and
# fetch + ffprobe real HLS output (master, variant playlist, first media segment).
set -uo pipefail
B=${BASE:-http://127.0.0.1}
EMAIL=${IO_ADMIN_EMAIL:?}; PASS=${IO_ADMIN_PASSWORD:?}
P=0; F=0; ok(){ P=$((P+1)); echo "PASS  $1"; }; bad(){ F=$((F+1)); echo "FAIL  $1"; }
AT=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))')
[ -n "$AT" ] && ok "login via nginx" || { bad "login via nginx"; exit 1; }
H="Authorization: Bearer $AT"
SLUG="docker-hls-$(date +%s)"
CID=$(curl -s -X POST $B/api/channels -H "$H" -H 'Content-Type: application/json' -d "{\"slug\":\"$SLUG\",\"name\":\"Docker HLS\",\"status\":\"ACTIVE\",\"streams\":{\"primary\":{\"sourceType\":\"LAVFI_TEST\",\"sourceUrl\":\"testsrc2\"}}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["channel"]["id"])')
[ -n "$CID" ] && ok "channel created" || { bad "channel created"; exit 1; }
curl -s -o /dev/null -X POST $B/api/streams/$CID/start -H "$H" -H 'Content-Type: application/json' -d '{"source":"PRIMARY"}'
ST=""; for i in $(seq 1 90); do ST=$(curl -s $B/api/streams/$CID/status -H "$H" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("live") or {}).get("state") or (d.get("persisted") or {}).get("state") or "")'); [ "$ST" = RUNNING ] && break; sleep 1; done
[ "$ST" = RUNNING ] && ok "stream RUNNING in container" || bad "stream RUNNING in container (state=$ST)"
LOC=$(curl -s -o /dev/null -w "%{redirect_url}" -H "$H" $B/api/channels/$CID/stream.m3u8)
[ -n "$LOC" ] && ok "stream.m3u8 redirect to signed master" || bad "redirect"
MASTER=$(curl -s "$LOC"); echo "$MASTER" | grep -q "EXT-X-STREAM-INF" && ok "master playlist has variants" || bad "master playlist has variants"
# Resolve URIs exactly as a player does (RFC 3986), using the tokens the server embeds in each URI.
VAR=$(echo "$MASTER" | grep -v '^#' | grep -v '^$' | head -1)
VURL=$(python3 -c 'import sys,urllib.parse as u;print(u.urljoin(sys.argv[1],sys.argv[2]))' "$LOC" "$VAR")
VBODY=$(curl -s "$VURL"); echo "$VBODY" | grep -q "^#EXTINF" && ok "variant playlist lists segments" || bad "variant playlist lists segments"
SEG=$(echo "$VBODY" | grep -v '^#' | grep -v '^$' | head -1)
SURL=$(python3 -c 'import sys,urllib.parse as u;print(u.urljoin(sys.argv[1],sys.argv[2]))' "$VURL" "$SEG")
TMP=/tmp/docker-seg.ts; HTTP=$(curl -s -o $TMP -w "%{http_code}" "$SURL"); [ "$HTTP" = 200 ] && ok "segment fetched through nginx with embedded token (HTTP 200)" || bad "segment fetch HTTP $HTTP"
FF=$(ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,sample_rate -of csv=p=0 $TMP 2>/dev/null | tr '\n' ' '); echo "      segment probe: $FF"
echo "$FF" | grep -q h264 && echo "$FF" | grep -q aac && ok "segment decodes as H.264 + AAC" || bad "segment probe"
curl -s -o /dev/null -X POST $B/api/streams/$CID/stop -H "$H"
echo "RESULT: PASS=$P FAIL=$F"; [ $F -eq 0 ]
