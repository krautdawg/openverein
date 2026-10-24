import { z } from 'zod';
import { email, levelSchema } from './auth.ts';

export const MODULE_LABEL: Record<string, string> = {
  members: 'Mitglieder',
  groups: 'Gruppen',
  fees: 'Beiträge',
  invoices: 'Rechnungen',
  sepa: 'SEPA',
  banking: 'Bank',
  ledger: 'Buchhaltung',
  donations: 'Spenden',
  communication: 'Kommunikation',
  documents: 'Dokumente',
  events: 'Termine',
  settings: 'Einstellungen',
  audit: 'Protokoll',
  imports: 'Import und Export',
  api: 'API',
};
export const FIELD_LABEL: Record<string, string> = { iban: 'IBAN', note: 'Notizen', birth_date: 'Geburtsdatum', email: 'E-Mail', phone: 'Telefon' };
export const LEVEL_LABEL = { none: 'Kein Zugriff', read: 'Lesen', write: 'Schreiben' } as const;

export const role = z.object({
  id: z.uuid(),
  name: z.string(),
  builtin: z.boolean(),
  permissions: z.record(z.string(), levelSchema),
  restrictedFields: z.array(z.string()),
});
export type Role = z.infer<typeof role>;

export const roleCreate = z.object({
  name: z.string().trim().min(2).max(80),
  permissions: z.record(z.string(), levelSchema),
  restrictedFields: z.array(z.string()).default([]),
});

export const grantInput = z.object({ roleId: z.uuid(), scopeGroupIds: z.array(z.uuid()).min(1, 'Mindestens eine Gruppe oder keine Beschränkung (null).').max(100).nullish() });

export const user = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  status: z.enum(['active', 'disabled']),
  invited: z.boolean(),
  lastLoginAt: z.string().nullable(),
  grants: z.array(z.object({ id: z.uuid(), roleId: z.uuid(), roleName: z.string(), scopeGroupIds: z.array(z.uuid()).nullable() })),
});
export type User = z.infer<typeof user>;

export const userCreate = z.object({ name: z.string().trim().min(2).max(120), email, grants: z.array(grantInput).min(1, 'Mindestens eine Rolle.') });
export const userPatch = z.object({ name: z.string().trim().min(2).max(120).optional(), status: z.enum(['active', 'disabled']).optional(), grants: z.array(grantInput).min(1).optional() });
export const inviteResult = z.object({ user, inviteToken: z.string(), expiresAt: z.string() });

export const effectivePermissions = z.object({
  modules: z.array(z.object({ module: z.string(), level: levelSchema, scope: z.array(z.string()).nullable() })),
  restrictedFields: z.array(z.string()),
});

export const apiToken = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  roleId: z.uuid(),
  roleName: z.string(),
  scopeGroupIds: z.array(z.uuid()).nullable(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
});
export const apiTokenCreate = z.object({
  name: z.string().trim().min(2).max(80),
  roleId: z.uuid(),
  scopeGroupIds: z.array(z.uuid()).min(1).nullish(),
  expiresInDays: z.number().int().min(1).max(365).default(365),
});

export const auditEvent = z.object({ id: z.number(), at: z.string(), actor: z.string(), action: z.string(), entityType: z.string(), entityId: z.string().nullable(), diff: z.unknown() });
export const auditQuery = z.object({
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(60).optional(),
  action: z.string().max(60).optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ACTION_LABEL: Record<string, string> = {
  'organization.setup': 'Verein eingerichtet',
  'organization.update': 'Vereinsdaten geändert',
  'auth.login': 'Angemeldet',
  'auth.login_failed': 'Anmeldung fehlgeschlagen',
  'auth.login_locked': 'Anmeldung gesperrt',
  'auth.invite_accepted': 'Einladung angenommen',
  'member.created': 'Mitglied angelegt',
  'member.updated': 'Mitgliedschaft geändert',
  'person.updated': 'Stammdaten geändert',
  'member.resigned': 'Kündigung erfasst',
  'member.resignation_withdrawn': 'Kündigung zurückgenommen',
  'member.admitted': 'Aufgenommen',
  'member.rejected': 'Antrag abgelehnt',
  'member.status_changed': 'Status automatisch geändert',
  'member.group_added': 'Gruppe hinzugefügt',
  'member.group_ended': 'Gruppe beendet',
  'member.group_deleted': 'Gruppenzuordnung gelöscht',
  'member.export': 'Liste exportiert',
  'member.bulk.add_to_group': 'Sammelaktion: Gruppe hinzugefügt',
  'member.bulk.end_group': 'Sammelaktion: Gruppe beendet',
  'group.created': 'Gruppe angelegt',
  'group.updated': 'Gruppe geändert',
  'group.archived': 'Gruppe archiviert',
  'group.unarchived': 'Gruppe wiederhergestellt',
  'user.created': 'Zugang angelegt',
  'user.updated': 'Zugang geändert',
  'user.invited': 'Einladung erstellt',
  'role.created': 'Rolle angelegt',
  'role.updated': 'Rolle geändert',
  'role.deleted': 'Rolle gelöscht',
  'api_token.created': 'API-Schlüssel erstellt',
  'api_token.revoked': 'API-Schlüssel widerrufen',
  'bank_account.created': 'Bankkonto angelegt',
  'bank_account.updated': 'Bankkonto geändert',
  'bank_import.created': 'Kontoauszug eingelesen',
  'bank_import.rolled_back': 'Kontoauszug zurückgerollt',
  'bank_transaction.allocated': 'Zahlung zugeordnet',
  'bank_transaction.ignored': 'Buchung abgehakt',
  'bank_transaction.unmatched': 'Zuordnung aufgehoben',
  'collection_item.returned': 'Rücklastschrift verbucht',
  'collection_run.downloaded': 'SEPA-Datei heruntergeladen',
  'collection_run.generated': 'SEPA-Datei erzeugt',
  'collection_run.released': 'Einzug freigegeben',
  'collection_run.submitted': 'Bei der Bank eingereicht',
  'fee_plan.created': 'Beitragsart angelegt',
  'fee_plan.deleted': 'Beitragsart gelöscht',
  'fee_plan.updated': 'Beitragsart geändert',
  'fee_plan.version_added': 'Neuer Beitragspreis',
  'fee_plan.retired': 'Beitragsart stillgelegt',
  'fee_plan.reactivated': 'Beitragsart reaktiviert',
  'fee_run.cancelled': 'Beitragslauf aufgehoben',
  'fee_run.posted': 'Beitragslauf gebucht',
  'fee_run.previewed': 'Beitragslauf-Vorschau erstellt',
  'invoice.cancelled': 'Rechnung storniert',
  'invoice.draft_deleted': 'Entwurf gelöscht',
  'invoice.drafted': 'Rechnungsentwurf angelegt',
  'invoice.draft_updated': 'Entwurf geändert',
  'invoice.dunning': 'Mahnstufe angewendet',
  'invoice.dunning_hold': 'Mahnpause gesetzt',
  'invoice.issued': 'Rechnung ausgestellt',
  'invoice.payment': 'Zahlung erfasst',
  'invoice.payment_reversed': 'Zahlung zurückgenommen',
  'invoice.written_off': 'Ausgebucht',
  'mandate.created': 'SEPA-Mandat erfasst',
  'mandate.expired': 'SEPA-Mandat abgelaufen',
  'mandate.revoked': 'SEPA-Mandat widerrufen',
  'mandate.activated': 'SEPA-Mandat aktiviert',
  'member.fee_assigned': 'Beitrag zugeordnet',
  'member.fee_ended': 'Beitrag beendet',
  'member.payment_method': 'Zahlungsart geändert',
};
