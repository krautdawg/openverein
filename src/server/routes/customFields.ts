import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { customField, customFieldInput, customFieldPatch } from '../../shared/customFields.ts';
import { audit } from '../audit.ts';
import { requireActor } from '../auth/session.ts';
import type { Db } from '../db.ts';
import { notFound, Problem } from '../http/problem.ts';
import { fieldsFor } from '../members/custom.ts';
import { requirePermission, type Actor } from '../policy.ts';

const tags = ['members'];
const idParam = z.object({ id: z.uuid() });

async function valueCount(db: Db, organizationId: string, fieldId: string) {
  const r = await db.selectFrom('person').select(sql<number>`count(*)::int`.as('n')).where('organization_id', '=', organizationId).where(sql<boolean>`custom ? ${fieldId}`).executeTakeFirstOrThrow();
  return r.n;
}

export const customFieldRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app;

  async function dto(actor: Actor, id?: string) {
    const fields = (await fieldsFor(db, actor, { archived: true })).filter((f) => !id || f.id === id);
    const counts = new Map((await sql<{ k: string; n: number }>`select k, count(*)::int as n from person, jsonb_object_keys(custom) k where organization_id = ${actor.organizationId} group by k`.execute(db)).rows.map((r) => [r.k, r.n]));
    return fields.map((f) => ({
      id: f.id, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required, position: f.position,
      visibleToMember: f.visible_to_member, editableByMember: f.editable_by_member, sensitive: f.sensitive, archived: !!f.archived_at,
      valueCount: counts.get(f.id) ?? 0,
    }));
  }

  app.get('/custom-fields', { schema: { tags, summary: 'Eigene Felder (sensible nur für Zugänge für den ganzen Verein)', response: { 200: z.array(customField) } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'members', 'read');
    return dto(actor);
  });

  app.post('/custom-fields', { schema: { tags, summary: 'Eigenes Feld anlegen', body: customFieldInput, response: { 201: customField } } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    const b = req.body;
    if ((b.type === 'select' || b.type === 'multiselect') && b.options.length < 2) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'options', message: 'Eine Auswahl braucht mindestens zwei Möglichkeiten.' }] });
    const f = await db.transaction().execute(async (tx) => {
      const f = await tx.insertInto('custom_field').values({ organization_id: actor.organizationId, key: b.key, label: b.label, type: b.type, options: b.options, required: b.required, position: b.position, visible_to_member: b.visibleToMember, editable_by_member: b.editableByMember, sensitive: b.sensitive }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, actor.organizationId, actor, { action: 'custom_field.created', entityType: 'custom_field', entityId: f.id, diff: { key: [null, b.key], type: [null, b.type] } });
      return f;
    });
    reply.status(201);
    return (await dto(actor, f.id))[0]!;
  });

  app.patch('/custom-fields/:id', { schema: { tags, summary: 'Eigenes Feld ändern (der Typ ist fest, sobald Werte existieren)', params: idParam, body: customFieldPatch, response: { 200: customField } } }, async (req) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    const b = req.body;
    await db.transaction().execute(async (tx) => {
      const f = await tx.selectFrom('custom_field').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!f) throw notFound('Feld');
      const used = await valueCount(tx, actor.organizationId, f.id);
      const type = b.type ?? f.type;
      if ((type === 'select' || type === 'multiselect') && (b.options ?? f.options).length < 2) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'options', message: 'Eine Auswahl braucht mindestens zwei Möglichkeiten.' }] });
      if (b.type && b.type !== f.type && used) throw new Problem(409, 'type-locked', 'Der Typ lässt sich nicht mehr ändern: Es gibt schon Werte.', 'Archiviere das Feld und leg ein neues an.');
      if (b.options && used && (f.type === 'select' || f.type === 'multiselect')) {
        const inUse = await tx.selectFrom('person').select(sql<string>`jsonb_array_elements_text(case jsonb_typeof(custom -> ${f.id}) when 'array' then custom -> ${f.id} else jsonb_build_array(custom -> ${f.id}) end)`.as('v')).where('organization_id', '=', actor.organizationId).where(sql<boolean>`custom ? ${f.id}`).execute();
        const missing = [...new Set(inUse.map((r) => r.v))].filter((v) => !b.options!.includes(v));
        if (missing.length) throw new Problem(409, 'option-in-use', `Diese Auswahl wird noch verwendet: ${missing.join(', ')}.`);
      }
      await tx.updateTable('custom_field').set({
        ...(b.label !== undefined ? { label: b.label } : {}), ...(b.type !== undefined ? { type: b.type } : {}), ...(b.options !== undefined ? { options: b.options } : {}),
        ...(b.required !== undefined ? { required: b.required } : {}), ...(b.position !== undefined ? { position: b.position } : {}),
        ...(b.visibleToMember !== undefined ? { visible_to_member: b.visibleToMember } : {}), ...(b.editableByMember !== undefined ? { editable_by_member: b.editableByMember } : {}),
        ...(b.sensitive !== undefined ? { sensitive: b.sensitive } : {}), ...(b.archived !== undefined ? { archived_at: b.archived ? new Date() : null } : {}),
      }).where('id', '=', f.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'custom_field.updated', entityType: 'custom_field', entityId: f.id, diff: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [k === 'archived' ? !!f.archived_at : (f as Record<string, unknown>)[k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] ?? null, v]])) });
    });
    return (await dto(actor, req.params.id))[0]!;
  });

  app.delete('/custom-fields/:id', { schema: { tags, summary: 'Eigenes Feld löschen; mit Werten nur, wenn der Name zur Bestätigung eingegeben wird', params: idParam, body: z.object({ confirm: z.string().optional() }).optional() } }, async (req, reply) => {
    const actor = requireActor(req);
    requirePermission(actor, 'settings', 'write');
    await db.transaction().execute(async (tx) => {
      const f = await tx.selectFrom('custom_field').selectAll().where('id', '=', req.params.id).where('organization_id', '=', actor.organizationId).forUpdate().executeTakeFirst();
      if (!f) throw notFound('Feld');
      const used = await valueCount(tx, actor.organizationId, f.id);
      if (used && req.body?.confirm !== f.label) throw new Problem(409, 'confirm-delete', `${used} Personen haben einen Wert in „${f.label}“.`, 'Gib zur Bestätigung den Namen des Feldes ein, oder archiviere es.', { valueCount: used });
      await tx.updateTable('person').set({ custom: sql`custom - ${f.id}` }).where('organization_id', '=', actor.organizationId).where(sql<boolean>`custom ? ${f.id}`).execute();
      await tx.deleteFrom('custom_field').where('id', '=', f.id).execute();
      await audit(tx, actor.organizationId, actor, { action: 'custom_field.deleted', entityType: 'custom_field', entityId: f.id, diff: { key: [f.key, null], values: [used, 0] } });
    });
    return reply.status(204).send();
  });
};
