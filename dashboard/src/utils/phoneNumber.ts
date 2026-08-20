export interface NormalizedPhone {
  normalized: string;
  valid: boolean;
  reason?: 'empty' | 'country-code' | 'length';
}

/**
 * Normalize a human-entered phone number to the digits-only MSISDN shape expected by the
 * WhatsApp number-check endpoint.
 *
 * Rules:
 * - +8490... and 008490... are treated as explicit international numbers.
 * - 090... is treated as a national number and the configured default country code replaces
 *   the leading trunk zero (84 by default).
 * - 8490... is already international and is preserved.
 * - formatting characters are ignored.
 *
 * This intentionally does not try to validate carrier prefixes. WhatsApp is the authoritative
 * source for account existence; the client only rejects shapes that cannot be E.164-like numbers.
 */
export function normalizePhoneNumber(input: string, defaultCountryCode = '84'): NormalizedPhone {
  const raw = input.trim();
  if (!raw) return { normalized: '', valid: false, reason: 'empty' };

  const countryCode = defaultCountryCode.replace(/\D/g, '');
  if (!countryCode || countryCode.length > 3 || countryCode.startsWith('0')) {
    return { normalized: '', valid: false, reason: 'country-code' };
  }

  const compact = raw.replace(/[\s().-]/g, '');
  let normalized: string;

  if (compact.startsWith('+')) {
    normalized = compact.slice(1).replace(/\D/g, '');
  } else if (compact.startsWith('00')) {
    normalized = compact.slice(2).replace(/\D/g, '');
  } else {
    const digits = compact.replace(/\D/g, '');
    normalized = digits.startsWith('0') ? `${countryCode}${digits.slice(1)}` : digits;
  }

  // E.164 allows up to 15 digits. Seven is a conservative lower bound that prevents accidental
  // short-code/extension checks while still supporting countries with short national numbers.
  if (normalized.length < 7 || normalized.length > 15) {
    return { normalized, valid: false, reason: 'length' };
  }

  return { normalized, valid: true };
}
