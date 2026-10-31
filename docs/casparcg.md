# CasparCG integration: install path and status

## Supported install path (researched)
- Official releases: https://github.com/CasparCG/server/releases (v2.4.3-stable is the newest stable listed; the project also points to casparcg.com/downloads).
- Requirements (from upstream README): an OpenGL 4.5 capable GPU is required. Ubuntu 24.04 is the recommended Linux target; other distributions must compile from source.
- No official Docker image is documented upstream. This project does NOT invent one. `io-casparcg` in deploy/docker-compose.yml is a placeholder that only runs under the `casparcg` profile with `CASPARCG_IMAGE` set by the operator.

## Status in this sandbox
- Host: Debian 13, no GPU. Installing CasparCG Server is therefore NOT verified: it needs OpenGL 4.5. A Mesa software renderer may or may not provide it; this has not been tested.
- The IO backend's AMCP client (src/lib/amcp.ts) and graphics layer (src/lib/graphics.ts) are implemented and typecheck, but have NOT been exercised against a live CasparCG server.
- Without CasparCG, `/api/graphics/*` returns 503 GRAPHICS_UNAVAILABLE. The platform runs without it (CASPARCG_ENABLED=false).

## To verify later
1. Install a CasparCG 2.4.x Linux build on a GPU host (or a host with a working OpenGL 4.5 software renderer).
2. Set CASPARCG_ENABLED=true, CASPARCG_HOST, CASPARCG_AMCP_PORT=5250.
3. Check `GET /api/graphics/status` shows connected=true, then TAKE a template and confirm the graphics_events row reaches VERIFIED.

## After Effects
AE is optional and external. It is not used on Android or in Linux containers.
