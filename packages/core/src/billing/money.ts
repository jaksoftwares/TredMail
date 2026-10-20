/**
 * Amounts are integers in minor units (cents). Mobile money moves whole shillings, so
 * KES invoice totals are rounded to whole units; other currencies keep their cents.
 */

const WHOLE_UNIT_CURRENCIES = new Set(["KES", "UGX", "TZS", "RWF"]);

export function roundForCurrency(amount: number, currency: string): number {
  if (WHOLE_UNIT_CURRENCIES.has(currency.toUpperCase())) return Math.round(amount / 100) * 100;
  return Math.round(amount);
}

/** "KES 2,500" or "USD 19.99". */
export function formatMoney(amount: number, currency: string): string {
  const major = amount / 100;
  const whole = Number.isInteger(major);
  return `${currency.toUpperCase()} ${major.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Tax on `subtotal` at `rateBasisPoints` (1600 = 16%), rounded for the currency. */
export function taxOn(subtotal: number, rateBasisPoints: number, currency: string): number {
  if (subtotal <= 0 || rateBasisPoints <= 0) return 0;
  return roundForCurrency((subtotal * rateBasisPoints) / 10_000, currency);
}
