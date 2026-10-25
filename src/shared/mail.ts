import { customText } from './customFields.ts';

/** Placeholders a mail may use. Values come from the recipient; nothing else is reachable (no code, no paths). */
export const PLACEHOLDERS = {
  vorname: 'Vorname',
  nachname: 'Nachname',
  name: 'Vollständiger Name',
  mitgliedsnummer: 'Mitgliedsnummer',
  verein: 'Name des Vereins',
  rechnungsnummer: 'Rechnungsnummer (nur bei Rechnungsversand)',
  betrag: 'Betrag (bei Rechnungen und Auslagen)',
  offen: 'Offener Betrag (nur bei Rechnungsversand)',
  faellig: 'Fälligkeitsdatum (nur bei Rechnungsversand)',
  mahnstufe: 'Bezeichnung der letzten Mahnstufe (nur bei Mahnungen)',
  link: 'Link (nur bei Einladungen und Anmeldecodes)',
  code: 'Anmeldecode (nur beim Anmeldecode)',
  entscheidung: 'Entscheidung mit Begründung (bei Änderungswünschen, Anträgen und Auslagen)',
  austritt: 'Austrittsdatum (nur bei Kündigungen)',
  bestaetigung: 'Nummer der Zuwendungsbestätigung (nur beim Versand von Bestätigungen)',
  jahre: 'Lebensjahre oder Jahre im Verein (nur bei Glückwünschen)',
} as const;
/** Fixed placeholders plus `custom.<key>` for the club's own (non-sensitive) fields. */
export type PlaceholderValues = Partial<Record<keyof typeof PLACEHOLDERS, string>> & { [custom: `custom.${string}`]: string };

/** Replaces {{vorname}}, {{custom.trikotgroesse}} etc.; unknown placeholders stay visible so the author notices them in the preview. */
export function fill(template: string, values: PlaceholderValues) {
  return template.replace(/\{\{\s*([a-z_]+(?:\.[a-z0-9_]+)?)\s*\}\}/g, (all, key: string) => (key in values ? (values[key as keyof PlaceholderValues] ?? '') : all));
}

/** `custom.<key>` values of one person for mail placeholders; sensitive fields are never offered. */
export function customPlaceholders(fields: { id: string; key: string; type: Parameters<typeof customText>[0]; sensitive: boolean }[], custom: Record<string, unknown> | null) {
  const out: Record<`custom.${string}`, string> = {};
  for (const f of fields) if (!f.sensitive) out[`custom.${f.key}`] = customText(f.type, custom?.[f.id]);
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Trailing punctuation and an escaped ">" belong to the sentence, not the link.
const link = (url: string) => {
  const m = url.match(/^(.*?)((?:[.,;:!?)]|&gt;)*)$/)!;
  return `<a href="${m[1]}">${m[1]}</a>${m[2]}`;
};

/** Plain text to simple HTML: paragraphs, line breaks, links. */
export function textToHtml(text: string) {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>').replace(/https?:\/\/[^\s<]+/g, link)}</p>`)
    .join('\n');
}

export type SystemTemplateKey = 'invoice' | 'dunning' | 'invitation' | 'login_code' | 'change_decided' | 'resignation_received' | 'application_received' | 'application_accepted' | 'application_rejected' | 'expense_decided' | 'donation_receipt' | 'birthday' | 'anniversary';
export const SYSTEM_TEMPLATES: Record<SystemTemplateKey, { name: string; subject: string; body: string }> = {
  invoice: {
    name: 'Rechnung',
    subject: 'Deine Rechnung {{rechnungsnummer}}',
    body: 'Hallo {{vorname}},\n\nanbei Deine Rechnung {{rechnungsnummer}} über {{betrag}}, fällig am {{faellig}}. Wenn Du uns ein SEPA-Mandat gegeben hast, ziehen wir den Betrag ein; die Rechnung kündigt die Lastschrift an.\n\nViele Grüße\n{{verein}}',
  },
  dunning: {
    name: 'Mahnung',
    subject: '{{mahnstufe}} zu Rechnung {{rechnungsnummer}}',
    body: 'Hallo {{vorname}},\n\nzu unserer Rechnung {{rechnungsnummer}} ist noch {{offen}} offen. Bitte überweise den Betrag in den nächsten Tagen. Falls Du schon gezahlt hast, betrachte diese Nachricht als erledigt.\n\nDie Rechnung liegt noch einmal bei.\n\nViele Grüße\n{{verein}}',
  },
  invitation: {
    name: 'Einladung für einen Zugang',
    subject: 'Dein Zugang zu {{verein}}',
    body: 'Hallo {{name}},\n\nfür Dich ist ein Zugang zur Vereinsverwaltung von {{verein}} eingerichtet. Leg hier Dein Passwort fest (der Link gilt 7 Tage):\n\n{{link}}\n\nViele Grüße\n{{verein}}',
  },
  login_code: {
    name: 'Anmeldecode für das Mitgliederportal',
    subject: 'Dein Anmeldecode: {{code}}',
    body: 'Hallo,\n\nDein Code für das Mitgliederportal von {{verein}} lautet:\n\n{{code}}\n\nEr gilt 10 Minuten. Du kannst ihn eingeben oder diesen Link öffnen und dort auf „Anmelden“ klicken:\n{{link}}\n\nWenn Du keinen Code angefordert hast, ignoriere diese E-Mail.\n\n{{verein}}',
  },
  change_decided: {
    name: 'Änderungswunsch entschieden',
    subject: 'Deine Änderung bei {{verein}}',
    body: 'Hallo {{vorname}},\n\n{{entscheidung}}\n\nViele Grüße\n{{verein}}',
  },
  application_received: {
    name: 'Aufnahmeantrag eingegangen',
    subject: 'Dein Aufnahmeantrag bei {{verein}}',
    body: 'Hallo {{vorname}},\n\ndanke für Deinen Antrag! Im Anhang findest Du eine Kopie davon. Der Vorstand meldet sich, sobald er entschieden hat.\n\nViele Grüße\n{{verein}}',
  },
  application_accepted: {
    name: 'Aufnahme bestätigt',
    subject: 'Willkommen bei {{verein}}',
    body: 'Hallo {{vorname}},\n\nwillkommen im Verein! Deine Mitgliedsnummer ist {{mitgliedsnummer}}.{{entscheidung}}\n\nViele Grüße\n{{verein}}',
  },
  donation_receipt: {
    name: 'Zuwendungsbestätigung',
    subject: 'Deine Zuwendungsbestätigung {{bestaetigung}}',
    body: 'Hallo {{vorname}},\n\nvielen Dank für Deine Unterstützung! Anbei Deine Zuwendungsbestätigung {{bestaetigung}} über {{betrag}} für das Finanzamt.\n\nViele Grüße\n{{verein}}',
  },
  birthday: {
    name: 'Glückwunsch zum Geburtstag',
    subject: 'Alles Gute zum Geburtstag, {{vorname}}!',
    body: 'Hallo {{vorname}},\n\nherzlichen Glückwunsch zum {{jahre}}. Geburtstag! Wir wünschen Dir einen schönen Tag und freuen uns, dass Du dabei bist.\n\nViele Grüße\n{{verein}}',
  },
  anniversary: {
    name: 'Glückwunsch zum Vereinsjubiläum',
    subject: '{{jahre}} Jahre im {{verein}}',
    body: 'Hallo {{vorname}},\n\nheute bist Du seit {{jahre}} Jahren Mitglied im {{verein}}. Danke für Deine Treue!\n\nViele Grüße\n{{verein}}',
  },
  expense_decided: {
    name: 'Auslage entschieden',
    subject: 'Deine Auslage bei {{verein}}',
    body: 'Hallo {{vorname}},\n\nDeine Auslage über {{betrag}}: {{entscheidung}}\n\nViele Grüße\n{{verein}}',
  },
  application_rejected: {
    name: 'Aufnahme abgelehnt',
    subject: 'Dein Aufnahmeantrag bei {{verein}}',
    body: 'Hallo {{vorname}},\n\nleider können wir Deinen Antrag nicht annehmen. {{entscheidung}}\n\nViele Grüße\n{{verein}}',
  },
  resignation_received: {
    name: 'Kündigung bestätigt',
    subject: 'Deine Kündigung bei {{verein}}',
    body: 'Hallo {{vorname}},\n\nwir haben Deine Kündigung erhalten. Nach der Satzung endet Deine Mitgliedschaft am {{austritt}}; der Vorstand bestätigt das noch.\n\nSchade, dass Du gehst. Danke für Deine Zeit im Verein!\n\n{{verein}}',
  },
};
