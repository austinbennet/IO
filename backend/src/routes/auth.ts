import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { authenticate, requireRole, type JwtUser, type Role } from '../auth.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/security.js';
import { recordSystemEvent } from '../lib/events.js';

const ROLES = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(12, 'Password must be at least 12 characters').max(256);

const registerBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(120).optional(),
  role: z.enum(ROLES).optional(),
});
const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(256) });
const refreshBody = z.object({ refreshToken: z.string().min(20).max(512) });
const updateUserBody = z.object({
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  displayName: z.string().trim().max(120).optional(),
});

// Dummy hash so unknown-email logins take the same time as known ones (no user enumeration by timing).
const DUMMY_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8Y0C4f5ZqkT8E2w6hG8qFZ1xOqG1Zi';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_active: boolean;
  role: Role;
  created_at: Date;
  last_login_at: Date | null;
}

function publicUser(u: Pick<UserRow, 'id' | 'email' | 'display_name' | 'role' | 'is_active' | 'created_at' | 'last_login_at'>) {
  return { id: u.id, email: u.email, displayName: u.display_name, role: u.role, isActive: u.is_active, createdAt: u.created_at, lastLoginAt: u.last_login_at };
}

async function issueTokens(app: FastifyInstance, user: Pick<UserRow, 'id' | 'email' | 'role'>) {
  const payload: JwtUser = { sub: user.id, role: user.role, email: user.email };
  const accessToken = app.jwt.sign(payload, { expiresIn: config.jwt.accessTtl });
  const refreshToken = randomToken();
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 86400_000);
  await query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [user.id, sha256(refreshToken), expiresAt]);
  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: config.jwt.accessTtl, refreshExpiresAt: expiresAt.toISOString() };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    const body = registerBody.parse(req.body);
    const countRes = await query<{ n: string }>('SELECT count(*)::text AS n FROM users');
    const isBootstrap = Number(countRes.rows[0].n) === 0;

    let role: Role = 'VIEWER';
    if (isBootstrap) {
      role = 'ADMIN'; // first account on a fresh install becomes the administrator
    } else {
      // After bootstrap only an ADMIN may create accounts.
      await requireRole('ADMIN')(req, reply);
      if (reply.sent) return;
      role = body.role ?? 'VIEWER';
    }

    const hash = await hashPassword(body.password);
    try {
      const row = (await query<UserRow>(
        `INSERT INTO users (email, display_name, password_hash, role_id)
         VALUES ($1, $2, $3, (SELECT id FROM roles WHERE name = $4))
         RETURNING id, email, display_name, password_hash, is_active, created_at, last_login_at,
           (SELECT name FROM roles WHERE id = role_id) AS role`,
        [body.email, body.displayName ?? '', hash, role],
      )).rows[0];
      await recordSystemEvent('INFO', 'auth', 'USER_CREATED', `User ${row.email} created with role ${row.role}`, { userId: row.id });
      return reply.code(201).send({ user: publicUser(row) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists' } });
      }
      throw err;
    }
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: config.rateLimit.loginMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const row = (await query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.is_active, u.created_at, u.last_login_at, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = lower($1)`,
      [body.email],
    )).rows[0];
    const ok = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } });
    }
    if (!row.is_active) {
      return reply.code(403).send({ error: { code: 'ACCOUNT_DISABLED', message: 'This account is disabled' } });
    }
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
    const tokens = await issueTokens(app, row);
    return { ...tokens, user: publicUser({ ...row, last_login_at: new Date() }) };
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const { refreshToken } = refreshBody.parse(req.body);
    const hash = sha256(refreshToken);
    const row = (await query<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
      'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1', [hash],
    )).rows[0];
    if (!row || row.revoked_at || row.expires_at < new Date()) {
      return reply.code(401).send({ error: { code: 'INVALID_REFRESH', message: 'Refresh token is invalid or expired' } });
    }
    // Rotation: a refresh token can be used once. Reuse of a revoked token revokes all sessions of the user.
    const user = (await query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.is_active, u.created_at, u.last_login_at, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [row.user_id],
    )).rows[0];
    if (!user || !user.is_active) return reply.code(401).send({ error: { code: 'INVALID_REFRESH', message: 'Account unavailable' } });
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    const tokens = await issueTokens(app, user);
    return tokens;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const body = refreshBody.safeParse(req.body);
    if (body.success) {
      await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(body.data.refreshToken)]);
    }
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: authenticate }, async (req) => {
    const row = (await query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.is_active, u.created_at, u.last_login_at, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [req.user!.sub],
    )).rows[0];
    if (!row) throw Object.assign(new Error('User not found'), { statusCode: 404, code: 'NOT_FOUND' });
    return { user: publicUser(row) };
  });

  app.get('/api/users', { preHandler: requireRole('ADMIN') }, async () => {
    const rows = (await query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.is_active, u.created_at, u.last_login_at, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.created_at`,
    )).rows;
    return { items: rows.map(publicUser) };
  });

  app.patch('/api/users/:id', { preHandler: requireRole('ADMIN') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateUserBody.parse(req.body);
    if (id === req.user!.sub && body.isActive === false) {
      return reply.code(422).send({ error: { code: 'SELF_LOCKOUT', message: 'You cannot disable your own account' } });
    }
    await query(
      `UPDATE users SET
         role_id = COALESCE((SELECT id FROM roles WHERE name = $2), role_id),
         is_active = COALESCE($3, is_active),
         display_name = COALESCE($4, display_name),
         updated_at = now()
       WHERE id = $1`,
      [id, body.role ?? null, body.isActive ?? null, body.displayName ?? null],
    );
    if (body.isActive === false) await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1', [id]);
    const row = (await query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.is_active, u.created_at, u.last_login_at, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [id],
    )).rows[0];
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    return { user: publicUser(row) };
  });
}
