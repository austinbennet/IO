# IO backend image. Build from the repository root:  docker build -f backend/Dockerfile .
# Layout mirrors the source tree (/opt/io/backend + /opt/io/graphics) because the app resolves
# graphics/ relative to its own location.
FROM node:20-bookworm-slim AS build
WORKDIR /opt/io/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production IO_DATA_DIR=/data
WORKDIR /opt/io/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /opt/io/backend/dist ./dist
COPY backend/migrations ./migrations
COPY graphics /opt/io/graphics
RUN mkdir -p /data/hls /data/recordings && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
