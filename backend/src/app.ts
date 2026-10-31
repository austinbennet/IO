import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config, ROOT_DIR } from './config.js';
import { query } from './db.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { broadcastRoutes } from './routes/broadcast.js';
import { systemRoutes } from './routes/system.js';
import { StreamError } from './lib/streamManager.js';
import { log } from './lib/events.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  if (config.env === 'production' && !config.jwt.secret) {
    throw new Error('JWT_SECRET must be set in production');
  }
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 90 * 1024 * 1024, // EPG imports can be large; per-route limits apply to uploads
    trustProxy: true, // behind Nginx
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: config.corsOrigins === '*' ? true : config.corsOrigins.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(jwt, { secret: config.jwt.secret || 'insecure-dev-only', sign: { expiresIn: config.jwt.accessTtl } });
  await app.register(rateLimit, { global: true, max: config.rateLimit.max, timeWindow: config.rateLimit.timeWindow });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 5 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'Request validation failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    if (err instanceof StreamError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      const code = (err as { code?: string }).code ?? 'BAD_REQUEST';
      return reply.code(status).send({ error: { code, message: err.message } });
    }
    log('ERROR', 'api', 'unhandled error', { method: req.method, url: req.url, err: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url.split('?')[0]}` } });
  });

  // Audit every state-changing API call (no request bodies are stored: they may contain secrets).
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || !req.url.startsWith('/api/')) return;
    const resource = req.url.split('?')[0].split('/')[3] ?? 'api';
    const userId = req.user?.sub && /^[0-9a-f-]{36}$/i.test(req.user.sub) ? req.user.sub : null;
    await query(
      'INSERT INTO audit_logs (user_id, action, resource, resource_id, ip, status_code, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId, `${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`, resource, null, req.ip, reply.statusCode, JSON.stringify({ ua: req.headers['user-agent']?.slice(0, 120) ?? null })],
    ).catch(() => undefined);
  });

  app.get('/api/meta', async () => ({
    name: 'IO Digital Broadcast',
    apiVersion: '1.0',
    ladder: config.ffmpeg.ladder,
    casparcgEnabled: config.casparcg.enabled,
    time: new Date().toISOString(),
  }));

  app.get('/api/docs/openapi.json', async (_req, reply) => {
    const file = path.join(ROOT_DIR, 'docs', 'openapi.json');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'OpenAPI document missing' } });
    reply.header('Content-Type', 'application/json');
    return reply.send(fs.readFileSync(file, 'utf8'));
  });

  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(broadcastRoutes);
  return app;
}
