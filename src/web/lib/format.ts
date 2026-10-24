/** 1536 → "1,5 KB" */
export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}
