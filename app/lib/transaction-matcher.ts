// Transaction matching stub for Phase 3 reconciliation.
// Provides matching functionality between balance and order transactions.

export interface TransactionMatch {
  readonly balanceTransactionId: string;
  readonly orderTransactionId: string | null;
  readonly matched: boolean;
  readonly reason: string;
}

export function matchTransaction(balanceId: string, orderIds: string[]): TransactionMatch {
  // Stub: to be implemented in Phase 3
  return {
    balanceTransactionId: balanceId,
    orderTransactionId: null,
    matched: false,
    reason: "stub",
  };
}
