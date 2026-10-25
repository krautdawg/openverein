const ONES = ['null', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

/** `last`: the final group of a number, where a trailing 1 is "eins" ("einhunderteins", but "einhunderteintausend"). */
function below1000(n: number, last: boolean): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const out = h ? `${ONES[h]}hundert` : '';
  if (r === 0) return out;
  // A trailing 1 is "eins" ("einhunderteins"); inside compounds it stays "ein" ("einundzwanzig").
  if (r < 20) return out + (r === 1 && out && last ? 'eins' : ONES[r]);
  const t = Math.floor(r / 10);
  const o = r % 10;
  return out + (o ? `${ONES[o]}und` : '') + TENS[t];
}

/** German number in words as written on donation receipts: 1250 → "eintausendzweihundertfünfzig". */
export function numberInWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error('only whole, non-negative numbers');
  if (n === 0) return 'null';
  if (n === 1) return 'eins';
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  let out = '';
  if (millions) out += millions === 1 ? 'einemillion' : `${below1000(millions, false)}millionen`;
  if (thousands) out += `${below1000(thousands, false)}tausend`;
  if (rest) out += rest === 1 ? 'eins' : below1000(rest, true);
  return out;
}

/** "zweihundertfünfzig Euro" or "zwölf Euro und fünfzig Cent"; before a noun a final "eins" is "ein". */
export function euroInWords(cents: number) {
  const words = (n: number) => numberInWords(n).replace(/eins$/, 'ein');
  const euros = Math.floor(cents / 100);
  const c = cents % 100;
  return `${words(euros)} Euro${c ? ` und ${words(c)} Cent` : ''}`;
}
