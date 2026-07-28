import { beforeEach, describe, expect, it, vi } from "vitest";

// The interval itself is inert under NODE_ENV=test, so the poller is driven
// one tick at a time here. Both collaborators are stubbed: what is under test
// is which shops a tick decides to trigger, not what a run then does.

const SHOP = "recon-test.myshopify.com";

const { adminFor, startRunMock } = vi.hoisted(() => ({
  adminFor: vi.fn(),
  startRunMock: vi.fn(),
}));

vi.mock("~/shopify.server", () => ({
  unauthenticated: { admin: (shop: string) => adminFor(shop) },
}));

vi.mock("~/db.server", () => ({
  default: { session: { findMany: async () => [{ shop: SHOP }] } },
}));

vi.mock("./run.server", () => ({
  startRun: (execute: unknown, shop: string, trigger: string) =>
    startRunMock(execute, shop, trigger),
}));

async function freshPoller() {
  delete (globalThis as { reconPollerGlobal?: unknown }).reconPollerGlobal;
  vi.resetModules();

  return import("./poller.server");
}

describe("poller tick", () => {
  beforeEach(() => {
    adminFor.mockReset();
    startRunMock.mockReset();
  });

  it("backs a shop off after a failed trigger instead of retrying every tick", async () => {
    adminFor.mockRejectedValue(new Error("no valid session for shop"));

    const poller = await freshPoller();

    await poller.tick();
    await poller.tick();

    // A shop whose admin context cannot be built must wait for its next poll
    // window like any other, not be retried four times a minute forever.
    expect(adminFor).toHaveBeenCalledTimes(1);
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("triggers a due shop once per poll interval", async () => {
    adminFor.mockResolvedValue({ admin: { graphql: vi.fn() } });
    startRunMock.mockResolvedValue("run-1");

    const poller = await freshPoller();

    await poller.tick();
    await poller.tick();

    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(startRunMock.mock.calls[0][1]).toBe(SHOP);
    expect(startRunMock.mock.calls[0][2]).toBe("poll");
  });

  it("runs a webhook request ahead of the poll window", async () => {
    adminFor.mockResolvedValue({ admin: { graphql: vi.fn() } });
    startRunMock.mockResolvedValue("run-1");

    const poller = await freshPoller();

    poller.requestSync(SHOP);
    await poller.tick();

    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(startRunMock.mock.calls[0][2]).toBe("webhook");
  });
});
