# IO Digital Broadcast

Backend (Node.js + TypeScript, Fastify, PostgreSQL, Redis, FFmpeg), tests, docs and deploy files. The Android app source is not included in this repo yet.

CI: `.github/workflows/backend-ci.yml` runs typecheck, unit tests, migrations and the API end-to-end suite against real PostgreSQL and Redis on every push.

GitHub Actions is NOT a production host. The live server must run on a machine that stays online.
