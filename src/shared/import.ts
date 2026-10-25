/** Import targets for member rows, with header names we recognise (German UI labels, easyVerein API names). */
export const TARGETS = {
  membershipNumber: { label: 'Mitgliedsnummer', synonyms: ['mitgliedsnummer', 'mitgliedsnr', 'mitgliednr', 'membershipnumber', 'nummer'] },
  firstName: { label: 'Vorname', synonyms: ['vorname', 'firstname'] },
  lastName: { label: 'Nachname', synonyms: ['nachname', 'familienname', 'familyname', 'lastname', 'name'] },
  companyName: { label: 'Firma', synonyms: ['firma', 'firmenname', 'companyname', 'organisation', 'unternehmen'] },
  birthDate: { label: 'Geburtsdatum', synonyms: ['geburtsdatum', 'geburtstag', 'dateofbirth', 'birthdate', 'geboren'] },
  email: { label: 'E-Mail', synonyms: ['email', 'emailadresse', 'emailprivat', 'privateemail', 'primaryemail', 'mail'] },
  phone: { label: 'Telefon', synonyms: ['telefon', 'telefonprivat', 'privatephone', 'telefonnummer', 'mobil', 'handy', 'mobiltelefon', 'mobilephone', 'phone'] },
  street: { label: 'Straße', synonyms: ['strasse', 'strassehausnummer', 'street', 'adresse', 'anschrift'] },
  postalCode: { label: 'PLZ', synonyms: ['plz', 'postleitzahl', 'zip', 'postalcode'] },
  city: { label: 'Ort', synonyms: ['ort', 'stadt', 'wohnort', 'city'] },
  country: { label: 'Land', synonyms: ['land', 'country', 'staat'] },
  joinDate: { label: 'Eintritt', synonyms: ['eintrittsdatum', 'eintritt', 'mitgliedseit', 'joindate', 'beitritt', 'beitrittsdatum'] },
  exitDate: { label: 'Austritt', synonyms: ['austrittsdatum', 'austritt', 'resignationdate', 'kuendigungzum', 'ende'] },
  groups: { label: 'Gruppen', synonyms: ['gruppen', 'mitgliedsgruppen', 'gruppe', 'abteilung', 'abteilungen', 'groups'] },
  iban: { label: 'IBAN', synonyms: ['iban'] },
  bic: { label: 'BIC', synonyms: ['bic', 'swift'] },
  accountHolder: { label: 'Kontoinhaber:in', synonyms: ['kontoinhaber', 'kontoinhaberin', 'bankaccountowner', 'inhaber'] },
  mandateReference: { label: 'Mandatsreferenz', synonyms: ['mandatsreferenz', 'mandatsid', 'mandatereference', 'sepamandat', 'sepamandatsreferenz'] },
  mandateDate: { label: 'Mandat unterschrieben am', synonyms: ['datumdessepamandats', 'mandatsdatum', 'mandatvom', 'sepadate', 'sepamandatsdatum', 'unterschriftsdatum'] },
  note: { label: 'Notiz', synonyms: ['notiz', 'bemerkung', 'kommentar', 'notizen', 'note'] },
} as const;
export type Target = keyof typeof TARGETS;

const norm = (h: string) => h.toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/[^a-z0-9]/g, '');

/** Suggests a target per header; each target is used at most once (first match wins). */
export function suggestMapping(headers: string[]): Record<string, Target | null> {
  const used = new Set<Target>();
  const out: Record<string, Target | null> = {};
  for (const h of headers) {
    const n = norm(h);
    const hit = (Object.keys(TARGETS) as Target[]).find((t) => !used.has(t) && (TARGETS[t].synonyms as readonly string[]).includes(n));
    out[h] = hit ?? null;
    if (hit) used.add(hit);
  }
  return out;
}

/** Parses CSV text (RFC 4180 quoting) with the separator that the header line uses most: ; , or tab. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const sep = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** "03.02.1990", "3.2.1990", "1990-02-03" → "1990-02-03"; anything else → null. */
export function parseDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let iso = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
