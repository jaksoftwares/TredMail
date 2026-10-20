/**
 * Kenyan mobile numbers in the international form M-Pesa expects: 2547XXXXXXXX or
 * 2541XXXXXXXX. Accepts 0712 345 678, 712345678, +254 712 345 678 and 254712345678.
 */
export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.startsWith("254") && digits.length === 12) national = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 10) national = digits.slice(1);
  else if (digits.length === 9) national = digits;
  else return null;
  return /^[17]\d{8}$/.test(national) ? `254${national}` : null;
}

/** 254712345678 -> 0712 *** 678, for showing a number without exposing it. */
export function maskPhone(phone: string): string {
  const national = phone.startsWith("254") ? `0${phone.slice(3)}` : phone;
  if (national.length < 7) return national;
  return `${national.slice(0, 4)} *** ${national.slice(-3)}`;
}
