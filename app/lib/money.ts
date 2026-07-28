// Money is integer minor units end to end. Shopify sends decimal strings;
// this module is the only place they are parsed or rendered, and it uses
// integer string math exclusively. No float ever touches an amount.
//
// A currency the table does not know, or a fraction longer than the
// currency's ISO 4217 exponent, is a hard error: a reconciliation tool that
// is quietly off by one minor unit is worse than one that stops.

export class UnknownCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(`Unknown currency code: ${currency}`);
    this.name = "UnknownCurrencyError";
  }
}

export class InvalidAmountError extends Error {
  constructor(
    readonly amount: string,
    reason: string,
  ) {
    super(`Invalid amount "${amount}": ${reason}`);
    this.name = "InvalidAmountError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Cannot combine ${actual} with ${expected}`);
    this.name = "CurrencyMismatchError";
  }
}

export interface Money {
  readonly minor: bigint;
  readonly currency: string;
}

// ISO 4217 minor-unit exponents. Codes absent from all three lists are
// unknown by design.
const EXPONENT_0 = "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF";

const EXPONENT_2 =
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV " +
  "BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUC CUP CVE " +
  "CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD " +
  "HNL HRK HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR " +
  "LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD " +
  "NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR " +
  "SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY " +
  "TTD TWD TZS UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG ZWL";

const EXPONENT_3 = "BHD IQD JOD KWD LYD OMR TND";

const EXPONENT_4 = "CLF UYW";

function entriesFor(codes: string, exponent: number): [string, number][] {
  return codes.split(" ").map((code) => [code, exponent]);
}

const EXPONENTS: ReadonlyMap<string, number> = new Map([
  ...entriesFor(EXPONENT_0, 0),
  ...entriesFor(EXPONENT_2, 2),
  ...entriesFor(EXPONENT_3, 3),
  ...entriesFor(EXPONENT_4, 4),
]);

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Minor-unit exponent for an ISO 4217 code. Throws on an unknown code. */
export function currencyExponent(currency: string): number {
  const exponent = EXPONENTS.get(currency);

  if (exponent === undefined) {
    throw new UnknownCurrencyError(currency);
  }

  return exponent;
}

/**
 * Parse a Shopify decimal string into minor units. A fraction longer than the
 * currency's exponent throws rather than rounding.
 */
export function parseMoney(amount: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  const match = DECIMAL_PATTERN.exec(amount);

  if (!match) {
    throw new InvalidAmountError(amount, "expected a plain decimal number");
  }

  const [, sign, whole, fraction = ""] = match;

  if (fraction.length > exponent) {
    throw new InvalidAmountError(
      amount,
      `${currency} allows at most ${exponent} fraction digit(s)`,
    );
  }

  const digits = whole + fraction.padEnd(exponent, "0");
  const value = BigInt(digits);

  return sign === "-" ? -value : value;
}

/** Exact inverse of parseMoney. Used only at the UI and CSV edges. */
export function formatMoney(minor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString();

  if (exponent === 0) {
    return negative ? `-${digits}` : digits;
  }

  const padded = digits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Sum amounts that must all be in `currency`. Any other currency in the input
 * throws, so no total can silently cross currencies.
 */
export function sumMinor(currency: string, values: ReadonlyArray<Money>): bigint {
  currencyExponent(currency);

  let total = 0n;

  for (const value of values) {
    if (value.currency !== currency) {
      throw new CurrencyMismatchError(currency, value.currency);
    }

    total += value.minor;
  }

  return total;
}
