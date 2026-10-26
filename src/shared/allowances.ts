export const ALLOWANCE_KINDS = ['uebungsleiter', 'ehrenamt'] as const;
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number];
export const ALLOWANCE_LABEL: Record<AllowanceKind, string> = { uebungsleiter: 'Übungsleiterpauschale', ehrenamt: 'Ehrenamtspauschale' };

/**
 * Yearly tax-free limits per person in cents (§ 3 Nr. 26 / 26a EStG): 2,400 / 720 € from 2013, 3,000 / 840 € from
 * 2021, 3,300 / 960 € from 2026. Add a row when the law changes. Years before the first row are not supported.
 */
export const ALLOWANCE_FIRST_YEAR = 2013;
const LIMITS: { from: number; uebungsleiter: number; ehrenamt: number }[] = [
  { from: 2013, uebungsleiter: 240_000, ehrenamt: 72_000 },
  { from: 2021, uebungsleiter: 300_000, ehrenamt: 84_000 },
  { from: 2026, uebungsleiter: 330_000, ehrenamt: 96_000 },
];
export function allowanceLimit(kind: AllowanceKind, year: number) {
  const row = [...LIMITS].reverse().find((l) => year >= l.from);
  if (!row) throw new RangeError(`Pauschalen vor ${ALLOWANCE_FIRST_YEAR} werden nicht unterstützt.`);
  return row[kind];
}
