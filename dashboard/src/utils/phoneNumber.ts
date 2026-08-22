export interface NormalizedPhone {
  normalized: string;
  valid: boolean;
  reason?: 'empty' | 'country-code' | 'format' | 'length';
}

/**
 * Normalize a human-entered phone number to the digits-only MSISDN shape expected by the
 * WhatsApp number-check endpoint.
 *
 * Rules:
 * - +8490... and 008490... are explicit international numbers.
 * - Digits-only values that already start with the selected country code are preserved.
 * - Long digits-only values (11+ digits) are treated as explicit international values, preserving
 *   the existing paste-friendly workflow for numbers copied without a leading +.
 * - Other values are interpreted as national numbers for the selected country: a leading trunk 0
 *   is removed before prefixing the country code; countries whose national numbers do not use a
 *   trunk 0 (for example US/Canada and India) are prefixed directly.
 * - Only common phone formatting characters are accepted. Letters and other characters are
 *   rejected instead of being silently stripped into a different number.
 *
 * This intentionally does not validate carrier/area-code allocation. The backend still enforces
 * the canonical 7–15 digit MSISDN trust boundary, while WhatsApp remains authoritative for account
 * registration state.
 */
export function normalizePhoneNumber(input: string, defaultCountryCode = '84'): NormalizedPhone {
  const raw = input.trim();
  if (!raw) return { normalized: '', valid: false, reason: 'empty' };

  if (!/^\d{1,3}$/.test(defaultCountryCode) || defaultCountryCode.startsWith('0')) {
    return { normalized: '', valid: false, reason: 'country-code' };
  }
  const countryCode = defaultCountryCode;

  if (!/^[+]?[-().\s\d]+$/.test(raw)) {
    return { normalized: '', valid: false, reason: 'format' };
  }

  const compact = raw.replace(/[\s().-]/g, '');
  if ((compact.match(/\+/g) ?? []).length > 1 || (compact.includes('+') && !compact.startsWith('+'))) {
    return { normalized: '', valid: false, reason: 'format' };
  }

  let normalized: string;
  if (compact.startsWith('+')) {
    normalized = compact.slice(1);
  } else if (compact.startsWith('00')) {
    normalized = compact.slice(2);
  } else {
    const digits = compact;
    const alreadySelectedInternational = digits.startsWith(countryCode) && digits.length >= 7;
    const likelyInternationalPaste = !digits.startsWith('0') && digits.length >= 11;

    if (alreadySelectedInternational || likelyInternationalPaste) {
      normalized = digits;
    } else {
      normalized = `${countryCode}${digits.startsWith('0') ? digits.slice(1) : digits}`;
    }
  }

  if (!/^[1-9]\d{6,14}$/.test(normalized)) {
    return { normalized, valid: false, reason: 'length' };
  }

  return { normalized, valid: true };
}
