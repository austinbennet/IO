import '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface JwtUser {
  sub: string;
  role: Role;
  email: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

/** Permission matrix. Mirrors the seed data in migrations/001_init.sql. ADMIN has every permission. */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<string> | '*'> = {
  ADMIN: '*',
  OPERATOR: new Set([
    'channels:read', 'channels:write', 'streams:control', 'graphics:control', 'recordings:control',
    'schedules:write', 'playlists:read', 'playlists:write', 'epg:read', 'epg:write', 'system:read',
  ]),
  VIEWER: new Set(['channels:read', 'epg:read', 'playlists:read', 'system:read']),
};

export function hasPermission(role: Role, permission: string): boolean {
  const perms = ROLE_PERMISSIONS[role];
  return perms === '*' || perms.has(permission);
}

/** Fastify preHandler: requires a valid access token. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid access token' } });
    return;
  }
}

/** Fastify preHandler factory: requires an authenticated user holding `permission`. */
export function requirePermission(permission: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticate(req, reply);
    if (reply.sent) return;
    if (!req.user || !hasPermission(req.user.role, permission)) {
      reply.code(403).send({ error: { code: 'FORBIDDEN', message: `Requires permission ${permission}` } });
    }
  };
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticate(req, reply);
    if (reply.sent) return;
    if (!req.user || !roles.includes(req.user.role)) {
      reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Insufficient role' } });
    }
  };
}
