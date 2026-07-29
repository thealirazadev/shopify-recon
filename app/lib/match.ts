// Matching is a deterministic staged pipeline, not a scoring heuristic. Stage
// one is the payout attachment the sync already stored; stage two resolves the
// source by identifier, or records the explicit reason it could not. Every
// input line leaves this module in exactly one state, and the same input always
// produces the same output.
//
// Pure: no Prisma, no clock. The recon pass looks the local counterparts up and
// hands them in.

export type MatchState = "matched" | "partial" | "unmatched";

export type MatchTargetType = "order_transaction" | "refund" | "adjustment";

export type MatchReason = "source_missing" | "amount_mismatch" | "currency_mismatch" | "no_source";

/** The balance transaction fields stage two reads. */
export interface MatchLine {
  readonly type: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly sourceOrderTransactionId: string | null;
}

export interface CounterpartTransaction {
  readonly id: string;
  readonly orderId: string;
  readonly kind: string;
  readonly currency: string;
  readonly amountMinor: bigint;
}

export interface CounterpartRefund {
  readonly id: string;
  readonly currency: string;
  readonly amountMinor: bigint;
}

/** Local rows the pipeline may link to, keyed the way it joins them. */
export interface MatchSources {
  readonly orderTransactionsByGid: ReadonlyMap<string, CounterpartTransaction>;
  readonly refundsByOrderId: ReadonlyMap<string, ReadonlyArray<CounterpartRefund>>;
}

export interface MatchResult {
  readonly matchState: MatchState;
  readonly matchTargetType: MatchTargetType | null;
  readonly matchTargetId: string | null;
  readonly matchReason: MatchReason | null;
}

/**
 * True for every type that describes itself instead of pointing at an order:
 * adjustment, dispute, reserve, transfer, and any type Shopify adds later.
 */
export function isAdjustmentLine(type: string): boolean {
  return type !== "charge" && type !== "refund";
}

const NO_SOURCE: MatchResult = {
  matchState: "unmatched",
  matchTargetType: null,
  matchTargetId: null,
  matchReason: "no_source",
};

const ADJUSTMENT: MatchResult = {
  matchState: "matched",
  matchTargetType: "adjustment",
  matchTargetId: null,
  matchReason: null,
};

function missingSource(targetType: MatchTargetType): MatchResult {
  return {
    matchState: "partial",
    matchTargetType: targetType,
    matchTargetId: null,
    matchReason: "source_missing",
  };
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Why a line and its counterpart disagree, or null when they agree. Currency is
 * checked first: comparing amounts across currencies is meaningless, so an
 * amount difference is only reported once both sides are the same currency.
 */
function disagreement(
  line: MatchLine,
  counterpart: { currency: string; amountMinor: bigint },
  compareAbsolute: boolean,
): MatchReason | null {
  if (line.currency !== counterpart.currency) {
    return "currency_mismatch";
  }

  const left = compareAbsolute ? absolute(line.amountMinor) : line.amountMinor;
  const right = compareAbsolute ? absolute(counterpart.amountMinor) : counterpart.amountMinor;

  return left === right ? null : "amount_mismatch";
}

function matchCharge(line: MatchLine, sources: MatchSources): MatchResult {
  if (!line.sourceOrderTransactionId) {
    return NO_SOURCE;
  }

  const counterpart = sources.orderTransactionsByGid.get(line.sourceOrderTransactionId);

  if (!counterpart) {
    return missingSource("order_transaction");
  }

  const reason = disagreement(line, counterpart, false);

  return {
    matchState: reason ? "partial" : "matched",
    matchTargetType: "order_transaction",
    matchTargetId: counterpart.id,
    matchReason: reason,
  };
}

/**
 * The Refund row the counterpart's order links, identified by an exact currency
 * and absolute amount equality. Two refunds of the same amount on one order
 * carry no identifier that tells them apart, so the line stays pointed at the
 * order transaction rather than picking one of them.
 */
function refundTargetFor(
  line: MatchLine,
  counterpart: CounterpartTransaction,
  sources: MatchSources,
): CounterpartRefund | null {
  const candidates = (sources.refundsByOrderId.get(counterpart.orderId) ?? []).filter(
    (refund) =>
      refund.currency === line.currency &&
      absolute(refund.amountMinor) === absolute(line.amountMinor),
  );

  return candidates.length === 1 ? candidates[0] : null;
}

function matchRefund(line: MatchLine, sources: MatchSources): MatchResult {
  if (!line.sourceOrderTransactionId) {
    return NO_SOURCE;
  }

  const counterpart = sources.orderTransactionsByGid.get(line.sourceOrderTransactionId);

  // A source that resolves to something other than a refund transaction leaves
  // the refund without a counterpart of the right kind, which is the same
  // situation as a row the mirror does not have.
  if (!counterpart || counterpart.kind !== "refund") {
    return missingSource("refund");
  }

  // A refund leaves the payout as a negative amount while the order-side row
  // records what was returned as positive, so the sides compare in absolutes.
  const reason = disagreement(line, counterpart, true);
  const refund = refundTargetFor(line, counterpart, sources);

  return {
    matchState: reason ? "partial" : "matched",
    matchTargetType: refund ? "refund" : "order_transaction",
    matchTargetId: refund ? refund.id : counterpart.id,
    matchReason: reason,
  };
}

/**
 * Stage two: the source resolution table from docs/architecture.md. Charges and
 * refunds resolve through sourceOrderTransactionId; every other type is
 * self-describing and is categorized as an adjustment line.
 */
export function matchTransaction(line: MatchLine, sources: MatchSources): MatchResult {
  if (line.type === "charge") {
    return matchCharge(line, sources);
  }

  if (line.type === "refund") {
    return matchRefund(line, sources);
  }

  return ADJUSTMENT;
}
