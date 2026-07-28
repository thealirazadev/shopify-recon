import { describe, expect, it } from "vitest";

import {
  CurrencyMismatchError,
  currencyExponent,
  formatMoney,
  InvalidAmountError,
  parseMoney,
  sumMinor,
  UnknownCurrencyError,
} from "./money";

describe("currencyExponent", () => {
  it("knows two, zero, three, and four digit currencies", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
    expect(currencyExponent("BHD")).toBe(3);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("CLF")).toBe(4);
  });

  it("throws a named error on an unknown code", () => {
    expect(() => currencyExponent("XYZ")).toThrow(UnknownCurrencyError);
  });
});

describe("parseMoney", () => {
  it("parses the checklist cases", () => {
    expect(parseMoney("10.00", "USD")).toBe(1000n);
    expect(parseMoney("1000", "JPY")).toBe(1000n);
    expect(parseMoney("1.234", "BHD")).toBe(1234n);
  });

  it("pads a short fraction to the currency exponent", () => {
    expect(parseMoney("10.5", "USD")).toBe(1050n);
    expect(parseMoney("10", "USD")).toBe(1000n);
    expect(parseMoney("1.2", "BHD")).toBe(1200n);
  });

  it("handles zero and negative amounts", () => {
    expect(parseMoney("0.00", "USD")).toBe(0n);
    expect(parseMoney("-0.00", "USD")).toBe(0n);
    expect(parseMoney("-47.10", "USD")).toBe(-4710n);
    expect(parseMoney("+47.10", "USD")).toBe(4710n);
    expect(parseMoney("-1", "JPY")).toBe(-1n);
  });

  it("throws when the fraction is longer than the exponent", () => {
    expect(() => parseMoney("10.001", "USD")).toThrow(InvalidAmountError);
    expect(() => parseMoney("10.1", "JPY")).toThrow(InvalidAmountError);
    expect(() => parseMoney("1.2345", "BHD")).toThrow(InvalidAmountError);
  });

  it("throws on an unknown currency", () => {
    expect(() => parseMoney("10.00", "XYZ")).toThrow(UnknownCurrencyError);
  });

  it("rejects anything that is not a plain decimal number", () => {
    for (const bad of ["", " 10.00", "10.00 ", "1,000.00", "1e3", "10.", ".50", "abc", "--1"]) {
      expect(() => parseMoney(bad, "USD")).toThrow(InvalidAmountError);
    }
  });

  it("carries values far beyond the safe float range exactly", () => {
    expect(parseMoney("90071992547409.91", "USD")).toBe(9007199254740991n);
    expect(parseMoney("90071992547409.92", "USD")).toBe(9007199254740992n);
  });
});

describe("formatMoney", () => {
  it("is the exact inverse of parseMoney", () => {
    const cases: [string, string][] = [
      ["10.00", "USD"],
      ["0.07", "USD"],
      ["-110.00", "USD"],
      ["1450.90", "USD"],
      ["1000", "JPY"],
      ["-1", "JPY"],
      ["1.234", "BHD"],
      ["90071992547409.92", "USD"],
    ];

    for (const [amount, currency] of cases) {
      expect(formatMoney(parseMoney(amount, currency), currency)).toBe(amount);
    }
  });

  it("pads values smaller than one major unit", () => {
    expect(formatMoney(7n, "USD")).toBe("0.07");
    expect(formatMoney(0n, "USD")).toBe("0.00");
    expect(formatMoney(-5n, "USD")).toBe("-0.05");
    expect(formatMoney(4n, "BHD")).toBe("0.004");
  });

  it("renders zero-decimal currencies without a decimal point", () => {
    expect(formatMoney(1000n, "JPY")).toBe("1000");
    expect(formatMoney(0n, "JPY")).toBe("0");
  });

  it("throws on an unknown currency", () => {
    expect(() => formatMoney(1000n, "XYZ")).toThrow(UnknownCurrencyError);
  });
});

describe("sumMinor", () => {
  it("sums amounts in the stated currency", () => {
    const total = sumMinor("USD", [
      { minor: 160800n, currency: "USD" },
      { minor: -4710n, currency: "USD" },
      { minor: -11000n, currency: "USD" },
    ]);

    expect(total).toBe(145090n);
  });

  it("returns zero for an empty list", () => {
    expect(sumMinor("USD", [])).toBe(0n);
  });

  it("throws when any value is in another currency", () => {
    expect(() =>
      sumMinor("USD", [
        { minor: 1000n, currency: "USD" },
        { minor: 1000n, currency: "EUR" },
      ]),
    ).toThrow(CurrencyMismatchError);
  });

  it("throws when the target currency is unknown", () => {
    expect(() => sumMinor("XYZ", [])).toThrow(UnknownCurrencyError);
  });
});
