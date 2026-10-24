/** Placeholders a mail may use. Values come from the recipient; nothing else is reachable (no code, no paths). */
export const PLACEHOLDERS = {
  vorname: 'Vorname',
  nachname: 'Nachname',
  name: 'Vollständiger Name',
  mitgliedsnummer: 'Mitgliedsnummer',
  verein: 'Name des Vereins',
  rechnungsnummer: 'Rechnungsnummer (nur bei Rechnungsversand)',
  betrag: 'Rechnungsbetrag (nur bei Rechnungsversand)',
  offen: 'Offener Betrag (nur bei Rechnungsversand)',
  faellig: 'Fälligkeitsdatum (nur bei Rechnungsversand)',
  mahnstufe: 'Bezeichnung der letzten Mahnstufe (nur bei Mahnungen)',
  link: 'Einladungslink (nur bei Einladungen)',
} as const;
export type PlaceholderValues = Partial<Record<keyof typeof PLACEHOLDERS, string>>;

/** Replaces {{vorname}} etc.; unknown placeholders stay visible so the author notices them in the preview. */
export function fill(template: string, values: PlaceholderValues) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key: string) => (key in values ? (values[key as keyof PlaceholderValues] ?? '') : all));
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

export type SystemTemplateKey = 'invoice' | 'dunning' | 'invitation';
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
};
