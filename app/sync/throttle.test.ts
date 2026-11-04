import { describe, expect, it } from "vitest";

import { UpstreamError } from "~/lib/errors";
import {
  adminExecutor,
  computeSleepMs,
  createThrottledClient,
  DEFAULT_COST_ESTIMATE,
  MAX_SLEEP_MS,
  RETRY_DELAY_MS,
} from "~/sync/throttle.server";

const FULL = { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 50 };

function costed(available: number, actualQueryCost: number) {
  return {
    requestedQueryCost: actualQueryCost,
    actualQueryCost,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate: 50 },
  };
}

const THROTTLED_BODY = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: { cost: costed(5, 10) },
};

describe("computeSleepMs", () => {
  it("does not sleep while the budget covers the call", () => {
    expect(computeSleepMs(FULL, DEFAULT_COST_ESTIMATE)).toBe(0);
    expect(computeSleepMs({ ...FULL, currentlyAvailable: 50 }, 50)).toBe(0);
  });

  it("waits for the deficit at the restore rate", () => {
    expect(computeSleepMs({ ...FULL, currentlyAvailable: 5 }, 10)).toBe(100);
    expect(computeSleepMs({ ...FULL, currentlyAvailable: 0 }, 50)).toBe(1000);
  });

  it("rounds up to the next whole millisecond", () => {
    expect(computeSleepMs({ ...FULL, restoreRate: 3, currentlyAvailable: 0 }, 1)).toBe(334);
  });

  it("caps the wait and survives a missing restore rate", () => {
    expect(computeSleepMs({ ...FULL, currentlyAvailable: 0, restoreRate: 0 }, 10)).toBe(10_000);
    expect(computeSleepMs({ ...FULL, currentlyAvailable: 0, restoreRate: 1 }, 5000)).toBe(
      MAX_SLEEP_MS,
    );
  });
});

describe("createThrottledClient", () => {
  it("sleeps the computed time when the observed cost exceeds the budget", async () => {
    const slept: number[] = [];
    const client = createThrottledClient(
      async () => ({ data: { ok: true }, extensions: { cost: costed(5, 10) } }),
      "test.myshopify.com",
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    // First call has no observed status yet, so it never sleeps; the response
    // leaves 5 points available against an observed cost of 10.
    await client.request("Probe", "query Probe { shop { id } }");
    await client.request("Probe", "query Probe { shop { id } }");

    expect(slept).toStrictEqual([100]);
  });

  it("retries a throttled call once and then fails the call", async () => {
    const slept: number[] = [];
    let calls = 0;
    const client = createThrottledClient(
      async () => {
        calls += 1;

        return THROTTLED_BODY;
      },
      "test.myshopify.com",
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    await expect(client.request("Probe", "query Probe { shop { id } }")).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(calls).toBe(2);
    expect(slept).toHaveLength(2);
  });

  it("succeeds when the retry after a throttle goes through", async () => {
    let calls = 0;
    const client = createThrottledClient(
      async () => {
        calls += 1;

        return calls === 1
          ? THROTTLED_BODY
          : {
              data: { shop: { id: "gid://shopify/Shop/1" } },
              extensions: { cost: costed(900, 10) },
            };
      },
      "test.myshopify.com",
      { sleep: async () => {} },
    );

    await expect(client.request("Probe", "query Probe { shop { id } }")).resolves.toStrictEqual({
      shop: { id: "gid://shopify/Shop/1" },
    });
    expect(calls).toBe(2);
  });

  it("retries a transport failure once before giving up", async () => {
    const slept: number[] = [];
    let calls = 0;
    const client = createThrottledClient(
      async () => {
        calls += 1;
        throw new Error("socket hang up");
      },
      "test.myshopify.com",
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    await expect(client.request("Probe", "query Probe { shop { id } }")).rejects.toThrow(
      /socket hang up/,
    );
    expect(calls).toBe(2);
    expect(slept).toStrictEqual([RETRY_DELAY_MS]);
  });

  it("does not retry a query Shopify rejected", async () => {
    let calls = 0;
    const client = createThrottledClient(
      async () => {
        calls += 1;

        return { errors: [{ message: "Field 'nope' doesn't exist" }] };
      },
      "test.myshopify.com",
      { sleep: async () => {} },
    );

    await expect(client.request("Probe", "query Probe { nope }")).rejects.toThrow(/doesn't exist/);
    expect(calls).toBe(1);
  });
});

// Shaped like the package's GraphqlQueryError: the client throws on a response
// with GraphQL errors and keeps the parsed body, with the errors nested.
function graphqlQueryError(body: { data?: unknown; errors: unknown[]; extensions?: unknown }) {
  return Object.assign(new Error("GraphQL operation failed"), {
    body: {
      data: body.data,
      extensions: body.extensions,
      errors: { networkStatusCode: 200, message: "failed", graphQLErrors: body.errors },
    },
  });
}

function fakeAdmin(graphql: () => Promise<Response>) {
  return { graphql } as unknown as Parameters<typeof adminExecutor>[0];
}

describe("adminExecutor", () => {
  it("returns a successful response body unchanged", async () => {
    const execute = adminExecutor(
      fakeAdmin(async () => new Response(JSON.stringify({ data: { ok: true } }))),
    );

    await expect(execute("query { ok }")).resolves.toStrictEqual({ data: { ok: true } });
  });

  it("hands a thrown throttle back as a body so the client paces and retries", async () => {
    const slept: number[] = [];
    let calls = 0;
    const execute = adminExecutor(
      fakeAdmin(async () => {
        calls += 1;

        if (calls === 1) {
          throw graphqlQueryError(THROTTLED_BODY);
        }

        return new Response(
          JSON.stringify({ data: { ok: true }, extensions: { cost: costed(900, 10) } }),
        );
      }),
    );
    const client = createThrottledClient(execute, "test.myshopify.com", {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await expect(client.request("Probe", "query Probe { ok }")).resolves.toStrictEqual({
      ok: true,
    });
    expect(calls).toBe(2);
    // The retry is paced from the budget the throttled response reported (5
    // points against a cost of 10), which a blind transport retry never sees.
    expect(slept).toStrictEqual([RETRY_DELAY_MS, 100]);
  });

  it("surfaces a thrown query rejection without retrying it", async () => {
    let calls = 0;
    const execute = adminExecutor(
      fakeAdmin(async () => {
        calls += 1;
        throw graphqlQueryError({ errors: [{ message: "Access denied for payouts" }] });
      }),
    );
    const client = createThrottledClient(execute, "test.myshopify.com", {
      sleep: async () => {},
    });

    await expect(client.request("Probe", "query Probe { ok }")).rejects.toThrow(
      /rejected Probe: Access denied for payouts/,
    );
    expect(calls).toBe(1);
  });

  it("rethrows failures that carry no GraphQL body", async () => {
    const execute = adminExecutor(
      fakeAdmin(async () => {
        throw new Error("socket hang up");
      }),
    );

    await expect(execute("query { ok }")).rejects.toThrow(/socket hang up/);
  });
});
