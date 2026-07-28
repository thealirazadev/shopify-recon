import { describe, expect, it } from "vitest";

import { InvalidShopDateError, InvalidTimeZoneError, payoutDate, shopDateRange } from "./dates";

const NEW_YORK = "America/New_York";

describe("payoutDate", () => {
  it("uses the shop-local calendar day, not the UTC one", () => {
    // 03:00 UTC is 23:00 the previous evening in New York.
    expect(payoutDate(new Date("2026-07-24T03:00:00Z"), NEW_YORK)).toBe("2026-07-23");
    expect(payoutDate(new Date("2026-07-24T03:00:00Z"), "UTC")).toBe("2026-07-24");
  });

  it("handles zones ahead of UTC rolling forward a day", () => {
    expect(payoutDate(new Date("2026-07-23T16:30:00Z"), "Pacific/Auckland")).toBe("2026-07-24");
    expect(payoutDate(new Date("2026-07-23T20:00:00Z"), "Asia/Tokyo")).toBe("2026-07-24");
  });

  it("is stable across the New York spring-forward day", () => {
    // DST starts 2026-03-08 at 07:00 UTC (02:00 local becomes 03:00 local).
    expect(payoutDate(new Date("2026-03-08T06:59:00Z"), NEW_YORK)).toBe("2026-03-08");
    expect(payoutDate(new Date("2026-03-08T07:01:00Z"), NEW_YORK)).toBe("2026-03-08");
    // 04:00 UTC on 2026-03-09 is still 2026-03-08 locally (EDT, UTC-4).
    expect(payoutDate(new Date("2026-03-09T03:59:00Z"), NEW_YORK)).toBe("2026-03-08");
    expect(payoutDate(new Date("2026-03-09T04:01:00Z"), NEW_YORK)).toBe("2026-03-09");
  });

  it("is stable across the New York fall-back day", () => {
    // DST ends 2026-11-01 at 06:00 UTC (02:00 EDT becomes 01:00 EST).
    expect(payoutDate(new Date("2026-11-01T05:30:00Z"), NEW_YORK)).toBe("2026-11-01");
    expect(payoutDate(new Date("2026-11-01T06:30:00Z"), NEW_YORK)).toBe("2026-11-01");
    // 04:59 UTC is still 2026-10-31 locally; 05:01 UTC has crossed midnight.
    expect(payoutDate(new Date("2026-11-01T03:59:00Z"), NEW_YORK)).toBe("2026-10-31");
    expect(payoutDate(new Date("2026-11-01T04:01:00Z"), NEW_YORK)).toBe("2026-11-01");
  });

  it("throws on an unknown timezone", () => {
    expect(() => payoutDate(new Date("2026-07-24T03:00:00Z"), "Mars/Olympus")).toThrow(
      InvalidTimeZoneError,
    );
  });

  it("throws on an invalid instant", () => {
    expect(() => payoutDate(new Date("not a date"), NEW_YORK)).toThrow(InvalidShopDateError);
  });
});

describe("shopDateRange", () => {
  it("returns half-open UTC bounds of the local days", () => {
    const range = shopDateRange("2026-07-01", "2026-07-31", NEW_YORK);

    // July is EDT (UTC-4): local midnight is 04:00 UTC.
    expect(range.start.toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-08-01T04:00:00.000Z");
  });

  it("covers a single day", () => {
    const range = shopDateRange("2026-07-24", "2026-07-24", NEW_YORK);

    expect(range.start.toISOString()).toBe("2026-07-24T04:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-07-25T04:00:00.000Z");
  });

  it("uses each boundary's own offset across a DST change", () => {
    // Range spans spring forward: start is EST (UTC-5), end is EDT (UTC-4).
    const range = shopDateRange("2026-03-01", "2026-03-31", NEW_YORK);

    expect(range.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-04-01T04:00:00.000Z");
  });

  it("resolves the spring-forward day to the first local moment that exists", () => {
    // Local 2026-03-08T00:00 exists (the gap is 02:00-03:00), so EST applies.
    const range = shopDateRange("2026-03-08", "2026-03-08", NEW_YORK);

    expect(range.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("handles a zone whose DST gap sits at local midnight", () => {
    // Chile springs forward at 00:00 local on 2026-09-06; midnight does not
    // exist, so the day starts at 01:00 local (03:00 UTC).
    const range = shopDateRange("2026-09-06", "2026-09-06", "America/Santiago");

    expect(range.start.toISOString()).toBe("2026-09-06T03:00:00.000Z");
  });

  it("brackets a fall-back day over its full 25 hours", () => {
    const range = shopDateRange("2026-11-01", "2026-11-01", NEW_YORK);

    expect(range.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(range.endExclusive.getTime() - range.start.getTime()).toBe(25 * 3_600_000);
  });

  it("round-trips against payoutDate at both edges", () => {
    const range = shopDateRange("2026-07-24", "2026-07-24", NEW_YORK);
    const lastMoment = new Date(range.endExclusive.getTime() - 1);

    expect(payoutDate(range.start, NEW_YORK)).toBe("2026-07-24");
    expect(payoutDate(lastMoment, NEW_YORK)).toBe("2026-07-24");
    expect(payoutDate(range.endExclusive, NEW_YORK)).toBe("2026-07-25");
  });

  it("rejects malformed, impossible, and reversed ranges", () => {
    expect(() => shopDateRange("2026-7-24", "2026-07-24", NEW_YORK)).toThrow(InvalidShopDateError);
    expect(() => shopDateRange("2026-02-30", "2026-03-01", NEW_YORK)).toThrow(InvalidShopDateError);
    expect(() => shopDateRange("2026-07-25", "2026-07-24", NEW_YORK)).toThrow(InvalidShopDateError);
  });
});
