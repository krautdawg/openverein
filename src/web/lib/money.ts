/** "12,50" / "12.50" / "1.234,5" → 1250 cents; null when not a valid amount. */
export function parseEuro(input: string): number | null {
  const s = input.trim().replace(/\s|€/g, '');
  if (!s) return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

export const euroInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
