export function periodStart(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

export const periodLabel = (period: string): string => period.slice(0, 7);

export function parsePeriodLabel(label: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label);
  return m ? `${m[1]}-${m[2]}-01` : null;
}
