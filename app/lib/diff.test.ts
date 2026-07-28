import { describe, expect, it } from "vitest";

import { isUnchanged } from "./diff";

describe("isUnchanged", () => {
  it("ignores columns the caller does not own", () => {
    const stored = { id: "abc", name: "#1001", updatedAt: new Date("2026-07-24T00:00:00Z") };

    expect(isUnchanged(stored, { name: "#1001" })).toBe(true);
    expect(isUnchanged(stored, { name: "#1002" })).toBe(false);
  });

  it("compares dates by instant, not identity", () => {
    const stored = { processedAt: new Date("2026-07-24T13:00:00Z") };

    expect(isUnchanged(stored, { processedAt: new Date("2026-07-24T13:00:00Z") })).toBe(true);
    expect(isUnchanged(stored, { processedAt: new Date("2026-07-24T13:00:01Z") })).toBe(false);
  });

  it("compares minor units exactly", () => {
    expect(isUnchanged({ amountMinor: 1000n }, { amountMinor: 1000n })).toBe(true);
    expect(isUnchanged({ amountMinor: 1000n }, { amountMinor: 1001n })).toBe(false);
  });

  it("treats a missing column and an explicit null as different", () => {
    expect(isUnchanged({ matchReason: null }, { matchReason: null })).toBe(true);
    expect(isUnchanged({ matchReason: null }, { matchReason: "no_source" })).toBe(false);
  });
});
