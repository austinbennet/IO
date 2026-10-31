# IO Digital Broadcast: development ledger

Status key: VERIFIED = measured by a command in this sandbox. PARTIAL = built, but only partly tested. UNVERIFIED = not run here. NOT DONE = missing.

## Environment
- Debian 13 x86_64, 2 vCPU, 1.9 GiB RAM (3 GiB swap added for the Gradle build), no GPU, no /dev/kvm, Docker not installed.
- Node 20.20.2, npm 10.8.2, Java 21.0.13 (openjdk-17 not in Debian 13 apt), FFmpeg 7.1.5 (libx264, AAC), PostgreSQL 17.11, Redis 7 (127.0.0.1 only).
- Android SDK at /opt/android/sdk (moved out of the workspace so snapshots stay under the file cap): platform-tools, platforms;android-35, build-tools 35.0.0, NDK 26.1.10909125.

## Phase 1: Backend core
| Task | Files | Result |
|---|---|---|
| Config, DB pool, migrations | backend/src/config.ts, db.ts, migrate.ts, migrations/001_init.sql | VERIFIED: migration applied to a fresh DB (PostgreSQL DDL only) |
| Security helpers (URL checks, media tokens) | src/lib/security.ts, fetchSafe.ts | VERIFIED via API suite (path traversal 404, forged token 401) |
| M3U parser and generator | src/lib/m3u.ts | VERIFIED: 12/12 unit tests (test/parsers.test.ts); import and export via API |
| XMLTV EPG | src/lib/xmltv.ts, services/epg.ts | VERIFIED: import, /api/epg/now, per-channel EPG via API suite |
| RBAC and auth | src/auth.ts, routes/auth.ts | VERIFIED: 63/63 API suite (login, refresh rotation, reuse rejection, logout revoke, role 403s) |
| Channels CRUD | routes/catalog.ts | VERIFIED: API suite. Fixed: PUT no longer resets defaulted fields |
| Playlists import | services/playlists.ts | VERIFIED: multipart import (fixed unnest cast). Playlist export with query token VERIFIED |

## Phase 2: Streaming, graphics, scheduler, recording
| Task | Files | Result |
|---|---|---|
| FFmpeg HLS ABR args | src/lib/ffmpegArgs.ts | VERIFIED: ffprobe of output shows H.264 640x360 + AAC 48 kHz, 2 ABR variants |
| Stream supervisor | src/lib/streamManager.ts | VERIFIED (see measurements below). Fixed: idempotent start only for live processes; RUNNING only after master.m3u8 and first segment |
| Recording | src/lib/recorder.ts | VERIFIED: 8.5 s MPEG-TS recording, status COMPLETED; download restricted to the recordings dir |
| Redis scheduler | src/lib/scheduler.ts | VERIFIED: one-shot START_STREAM fired at its scheduled time; Redis lock plus PostgreSQL claim |
| CasparCG AMCP and graphics | src/lib/amcp.ts, graphics.ts | UNVERIFIED: no CasparCG server available. Without it, /api/graphics returns 503 GRAPHICS_UNAVAILABLE |
| CasparCG template generator | graphics/build-templates.mjs | VERIFIED: generated 29 templates in graphics/templates/io plus graphics/catalog.json. See open question |
| Monitoring | routes/system.ts | VERIFIED: /api/system/health and /metrics return live data |

## Phase 3: Mobile app (React Native 0.76.9)
| Task | Files | Result |
|---|---|---|
| Project and deps | mobile/ (package com.io.broadcast) | VERIFIED: npm install, react-navigation 6, react-native-video 6.7.0 (ExoPlayer/Media3), react-native-keychain, AsyncStorage |
| Screens | mobile/App.tsx, src/screens/*.tsx | PARTIAL: TypeScript typecheck passes (tsc --noEmit). Not run on a device |
| Configurable server URL | src/session.tsx, screens/LoginScreen.tsx, SettingsScreen.tsx | Code present. Stored in AsyncStorage; no URL is hardcoded |
| Secure token storage | src/session.tsx | Code present (Android Keystore via react-native-keychain) |
| Release build | `cd android && ./gradlew assembleRelease` | VERIFIED: BUILD SUCCESSFUL in 14m25s. APK 37,655,951 bytes (36 MB), package com.io.broadcast, minSdk 24, targetSdk 34. Contains Hermes, JS bundle (1.1 MB), Media3 ExoPlayer |
| APK launches on device or emulator | - | UNVERIFIED: no KVM, so no emulator here. No device attached |
| APK talks to deployed backend | - | PARTIAL: every endpoint used by the app returns the expected shape from the live backend (checked with curl). The on-device network path is UNVERIFIED |

APK signing: the release build is signed with the default debug key (Gradle template). It is installable for testing but is not a production signing key.

## Phase 4: Deployment, docs, backups
| Task | Files | Result |
|---|---|---|
| Backend Dockerfile | backend/Dockerfile | VERIFIED: docker.io 26.1.5 installed; image built from repo root (ffmpeg included) |
| Compose stack | deploy/docker-compose.yml | VERIFIED: io-postgres, io-redis (password-protected), io-api, io-nginx up and healthy. Only nginx port 80 published (443 removed until TLS is configured). AMCP, PostgreSQL, Redis and 8080 not published. io-casparcg only under the `casparcg` profile. Scheduler, streams and monitoring run in the io-api process |
| nginx | deploy/nginx/default.conf | VERIFIED: /api, /ws, /hls, /healthz proxied; other paths 404 |
| Env example | deploy/.env.example, backend/.env.example | Written; secrets replaced |
| Backup | deploy/scripts/backup.sh | VERIFIED: pg_dump custom format. Restore VERIFIED into a scratch DB: row counts match for users, channels, streams, schedules, recordings. Container dump also taken with docker exec pg_dump (28 data tables) |
| OpenAPI | docs/openapi.json | Route inventory only: 63 operations, 55 paths, generated from route definitions. Request and response schemas not written |
| CasparCG path | docs/casparcg.md | Researched: official releases on GitHub, OpenGL 4.5 GPU required, no official Docker image. Not installed (UNVERIFIED) |

## Tests run (final)
- Unit: parsers.test.ts 12/12 pass (run after the latest m3u changes and typecheck).
- Typecheck: backend `tsc --noEmit` passes across all sources, including app.ts and server.ts (first typecheck of those two files).
- API suite tests/e2e-api.sh: 63/63 PASS on a freshly migrated database.
- Streaming suite tests/e2e-streaming.sh: 16/16 PASS.
- Mobile: tsc --noEmit passes. APK built.

## Measured timings

Dev host (streaming suite, 2 runs):
| Measurement | Run 1 | Run 2 (final) |
|---|---|---|
| Crash restart after SIGKILL to RUNNING | 4.9 s | 8.2 s |
| Primary origin loss to RUNNING on BACKUP | 17.0 s | 20.6 s |

Failover is NOT under 10 seconds. Do not claim sub-10 s failover or 99.99% availability.

## Errors and fixes (this phase)
- Gradle build on 1.9 GiB RAM: added 3 GiB swap, capped the Gradle heap to 1536 MB, and limited ABIs to arm64-v8a and x86_64. Build then succeeded.
- `swapon` not on default PATH: used /usr/sbin.
- API suite run 1 failed (52 FAIL): the suite registers a bootstrap admin and needs an empty users table; the DB was not empty. Fixed by dropping and re-migrating the dev DB.
- Parallel run: I started the API server and the suite in the same tool call, so the suite hit a closed port. Rerun sequentially.
- Playlist export mutated the request Authorization header for ?access_token=. Replaced with direct verification and an explicit permission check (open issue closed).
- Mobile: a leftover no-op branch in session.tsx and a bad Muted prop were removed. A bogus type import was removed from PlaylistsScreen.tsx.

## Open items and remaining work
1. CasparCG: install and test against a live server (needs a GPU host or a working OpenGL 4.5 renderer). Not verified.
2. Android: install the APK on a device or emulator, sign in to a deployed backend, and test playback. Not verified.
3. TLS: add certificates and port 443 to nginx before any public exposure.
4. Full OpenAPI schemas (request and response).
5. Production signing key for the APK (current build uses the debug key).
6. Template count: the generator emits 29 templates. The spec, as recorded in session notes, lists 16. Needs confirmation.
7. Failover target under 10 s is not met (measured 17-21 s).

## Phase 5: Verification on the Docker stack (this session)
Fixes found while deploying:
- Redis ran with `--protected-mode yes` and no password, so the API container could not connect (EPIPE/ECONNRESET). Fixed: `--requirepass` from REDIS_PASSWORD, internal network only.
- The graphics catalog was missing in the image (the app resolves graphics/ relative to its own location). Fixed: image mirrors the source layout under /opt/io (backend + graphics); build context is the repo root with .dockerignore.
- HLS playlists used relative URIs without the media token, so a player that drops the query string could not fetch segments after the access token expired. Fixed: the server rewrites every relative URI in .m3u8 responses to carry a freshly signed media token (live players refetch playlists, so tokens stay current). Verified with a token-free segment request (HTTP 200, decodes as H.264 + AAC).
- The API suite assumed bare variant URIs and appended a second token. Test corrected: it now checks that embedded tokens are present and uses them.

Results:
| Check | Result |
|---|---|
| `npx tsc --noEmit` (backend, all sources) | PASS |
| API suite `tests/e2e-api.sh` against the Docker stack via nginx (fresh DB) | PASS 64/64 |
| API suite against the dev server (fresh DB, before the HLS change) | PASS 63/63 |
| Streaming suite `tests/e2e-streaming.sh` on dev server, after the HLS change | PASS 16/16; crash restart 7.9 s; failover 20.6 s |
| HLS via the Docker stack, nginx only, `tests/e2e-docker-hls.sh` | PASS 8/8: stream RUNNING in container, master and variant fetched, segment decodes H.264 + AAC 640x360 / 48 kHz |
| Restore of a pg_dump into a scratch DB | PASS (row counts match) |
| Dev host full restart, `tests/e2e-restart.sh` | PASS 6/6 twice: 5.8 s and 5.6 s |
| Docker container restart, `tests/e2e-docker-restart.sh` | PASS 4/4: 5.9 s |

Not verified:
- Android launch on a device or emulator (no KVM and no device).
- APK to deployed backend on device (the endpoints the app calls were checked over HTTP through nginx, not from the app).
- Failover under 10 s (measured 20.6 s).
- CasparCG TAKE (no CasparCG server).
- TLS / HTTPS (port 443 not configured).
- Long-running (hours) playback.
- Schema for OpenAPI (route inventory only).

Environment notes:
- Test suites leave streams running when they fail, and MAX_CONCURRENT_STREAMS=2 counts them. The restart test now stops leftovers first.
- Docker volumes (pgdata) hold the test data from the last run. `docker compose down -v` resets it.

## Delivery (this session)
- Workspace was over the snapshot cap (about 15,400 files) because the Android SDK sat under /home/user. SDK moved to /opt/android/sdk; mobile/android/local.properties updated. Workspace now about 280 files.
- APK checked for secrets (JWT, password, POSTGRES_PASSWORD strings): none found.
- Uploaded to GoFile: https://gofile.io/d/etYbf5fX (MD5 d1a2471b5139831c93fe6ba72fa25a1d matches the local file). Catbox returned "Invalid uploader" and Litterbox returned HTTP 500.
- Link recorded in deliverables/DOWNLOAD_LINK.txt.
