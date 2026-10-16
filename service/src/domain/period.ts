// A "period" is one calendar month in UTC, written as its first day: '2026-10-01'.
// Usage resets simply because a new month means a new counter row: nothing is ever reset or deleted.
// UTC (not the server's or the user's local time) so every instance and every client agrees on
// when the month changes.
export function periodStart(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

// '2026-10-01' -> '2026-10' (what the API shows)
export const periodLabel = (period: string): string => period.slice(0, 7);

// '2026-10' -> '2026-10-01', or null if the text is not a valid year-month.
export function parsePeriodLabel(label: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label);
  return m ? `${m[1]}-${m[2]}-01` : null;
}
