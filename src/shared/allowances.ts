export const ALLOWANCE_KINDS = ['uebungsleiter', 'ehrenamt'] as const;
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number];
export const ALLOWANCE_LABEL: Record<AllowanceKind, string> = { uebungsleiter: 'Übungsleiterpauschale', ehrenamt: 'Ehrenamtspauschale' };

/**
 * Yearly tax-free limits per person in cents (§ 3 Nr. 26 / 26a EStG). Raised from 2026 (3,000 → 3,300 € and
 * 840 → 960 €). Add a row when the law changes; years before the first row use it.
 */
const LIMITS: { from: number; uebungsleiter: number; ehrenamt: number }[] = [
  { from: 2021, uebungsleiter: 300_000, ehrenamt: 84_000 },
  { from: 2026, uebungsleiter: 330_000, ehrenamt: 96_000 },
];
export function allowanceLimit(kind: AllowanceKind, year: number) {
  const row = [...LIMITS].reverse().find((l) => year >= l.from) ?? LIMITS[0]!;
  return row[kind];
}
