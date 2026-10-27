import { z } from 'zod';
import { MODULE_LABEL } from './access.ts';

/** Personal tokens for agents (change agent-access): shared by the web app, the portal and the server. */
export const TOKEN_ACCESS_LABEL = { read: 'Nur lesen', write: 'Lesen und ändern' } as const;
export const CHANNEL_LABEL = { rest: 'API', mcp: 'MCP', cli: 'Kommandozeile' } as const;

const base = {
  name: z.string().trim().min(1, 'Gib dem Token einen Namen, z. B. „Claude".').max(80),
  access: z.enum(['read', 'write']).default('read'),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).default(90),
};
/** Admin access: optionally limited to some modules (none given = everything the access may do). */
export const adminTokenCreate = z.object({ ...base, modules: z.array(z.string().refine((m) => m in MODULE_LABEL, 'Unbekannter Bereich.')).min(1).max(20).nullish() });
export const memberTokenCreate = z.object(base);

export const personalToken = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  access: z.enum(['read', 'write']),
  modules: z.array(z.string()).nullable(),
  viaOAuth: z.boolean(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
  createdAt: z.string(),
  calls24h: z.number(),
  recentCalls: z.array(z.object({ at: z.string(), operation: z.string(), channel: z.enum(['rest', 'mcp', 'cli']), status: z.number() })),
});
export type PersonalTokenDto = z.infer<typeof personalToken>;
export const tokenCreated = z.object({ token: z.string(), personalToken });
