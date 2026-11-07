export class InvalidPhoneError extends Error {
  constructor() {
    // Never include the input: it is a phone number.
    super('invalid phone number');
    this.name = 'InvalidPhoneError';
  }
}

/**
 * Normalise a phone number to E.164 digits without the "+" (what WhatsApp sends in `from`):
 * `+91 98765 43210`, `91 98765-43210`, `919876543210` and `98765 43210` all become `919876543210`.
 *
 * A bare 10-digit number (or one with a leading trunk "0") is assumed to be Indian (+91), because
 * users type their caregiver's number that way. Anything longer is kept as given.
 * Throws InvalidPhoneError when the result is not 8–15 digits (E.164 limits).
 */
export function normalisePhone(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length === 10) {
    digits = `91${digits}`;
  }
  if (digits.length < 8 || digits.length > 15) {
    throw new InvalidPhoneError();
  }
  return digits;
}
