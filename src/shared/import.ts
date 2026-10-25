/** Import targets for member rows, with header names we recognise (German UI labels, easyVerein API names). */
export const TARGETS = {
  membershipNumber: { label: 'Mitgliedsnummer', synonyms: ['mitgliedsnummer', 'mitgliedsnr', 'mitgliednr', 'membershipnumber', 'nummer'] },
  firstName: { label: 'Vorname', synonyms: ['vorname', 'firstname'] },
  lastName: { label: 'Nachname', synonyms: ['nachname', 'familienname', 'familyname', 'lastname'] },
  companyName: { label: 'Firma', synonyms: ['firma', 'firmenname', 'companyname', 'organisation', 'unternehmen'] },
  birthDate: { label: 'Geburtsdatum', synonyms: ['geburtsdatum', 'geburtstag', 'dateofbirth', 'birthdate', 'geboren'] },
  email: { label: 'E-Mail', synonyms: ['email', 'emailadresse', 'emailprivat', 'privateemail', 'primaryemail', 'mail'] },
  phone: { label: 'Telefon', synonyms: ['telefon', 'telefonprivat', 'privatephone', 'telefonnummer', 'mobil', 'handy', 'mobiltelefon', 'mobilephone', 'phone'] },
  street: { label: 'Straße', synonyms: ['strasse', 'strassehausnummer', 'strasseundhausnummer', 'street'] },
  postalCode: { label: 'PLZ', synonyms: ['plz', 'postleitzahl', 'zip', 'postalcode'] },
  city: { label: 'Ort', synonyms: ['ort', 'stadt', 'wohnort', 'city'] },
  country: { label: 'Land', synonyms: ['land', 'country', 'staat'] },
  joinDate: { label: 'Eintritt', synonyms: ['eintrittsdatum', 'eintritt', 'mitgliedseit', 'joindate', 'beitritt', 'beitrittsdatum'] },
  exitDate: { label: 'Austritt', synonyms: ['austrittsdatum', 'austritt', 'resignationdate', 'kuendigungzum'] },
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

// Ambiguous headers ("Name" may be the full name) only count when nothing clearer took the target.
const WEAK: Partial<Record<Target, string[]>> = { lastName: ['name'], street: ['adresse', 'anschrift'] };

/** Suggests a target per header; each target is used at most once, clear names before ambiguous ones. */
export function suggestMapping(headers: string[]): Record<string, Target | null> {
  const used = new Set<Target>();
  const out: Record<string, Target | null> = Object.fromEntries(headers.map((h) => [h, null]));
  for (const pass of ['strong', 'weak'] as const) {
    for (const h of headers) {
      if (out[h]) continue;
      const n = norm(h);
      const hit = (Object.keys(TARGETS) as Target[]).find((t) => !used.has(t) && ((pass === 'strong' ? TARGETS[t].synonyms : (WEAK[t] ?? [])) as readonly string[]).includes(n));
      if (hit) {
        out[h] = hit;
        used.add(hit);
      }
    }
  }
  return out;
}

/** Header names made unique ("Telefon", "Telefon (2)"), so two columns never overwrite each other. */
export function uniqueHeaders(headers: string[]) {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const name = h.trim() || 'Spalte';
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

const COUNTRIES: Record<string, string> = { deutschland: 'DE', germany: 'DE', oesterreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH', niederlande: 'NL', frankreich: 'FR', polen: 'PL', italien: 'IT', luxemburg: 'LU', belgien: 'BE', daenemark: 'DK' };
/** "Österreich", "AT", "at" → "AT"; unknown → null. */
export function countryCode(v: string) {
  const s = v.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRIES[norm(s)] ?? null;
}

/** Parses CSV text (RFC 4180 quoting) with the separator the header line uses most outside quotes: ; , or tab. */
export function parseCsvLines(text: string): { cells: string[]; line: number }[] {
  const clean = text.replace(/^\uFEFF/, '');
  const header = clean.slice(0, clean.search(/\r?\n|$/)).replace(/"[^"]*"/g, '');
  const sep = [';', ',', '\t'].sort((a, b) => header.split(b).length - header.split(a).length)[0]!;
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === '\n') line++;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') { i++; line++; }
      else if (c === '\r') line++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push({ cells: row, line: start });
      row = [];
      field = '';
      start = line;
    } else field += c;
  }
  if (quoted) throw new Error(`In Zeile ${start} fehlt ein schließendes Anführungszeichen.`);
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push({ cells: row, line: start });
  return rows;
}

export const parseCsv = (text: string) => parseCsvLines(text).map((r) => r.cells);

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
