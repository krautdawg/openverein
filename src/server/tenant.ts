import type { FastifyRequest } from 'fastify';
import { config } from './config.ts';
import type { Db } from './db.ts';

/**
 * The club a public request (portal sign-in) is meant for. One club per installation: that club. Managed hosting
 * (MULTI_TENANT=true): the club whose host name the request came in on, or none.
 */
export async function tenantForRequest(db: Db, req: Pick<FastifyRequest, 'hostname'>) {
  const q = db.selectFrom('organization').select(['id', 'hostname']);
  if (!config.multiTenant) return q.orderBy('created_at').executeTakeFirst();
  const host = req.hostname.toLowerCase().replace(/:\d+$/, '');
  return q.where('hostname', '=', host).executeTakeFirst();
}

/** Base address for links in mails of one club: its own host under managed hosting, else PUBLIC_URL. */
export function baseUrlOf(org: { hostname: string | null } | undefined) {
  return config.multiTenant && org?.hostname ? `https://${org.hostname}` : config.publicUrl;
}

export async function baseUrlFor(db: Db, organizationId: string) {
  return baseUrlOf(await db.selectFrom('organization').select('hostname').where('id', '=', organizationId).executeTakeFirst());
}
