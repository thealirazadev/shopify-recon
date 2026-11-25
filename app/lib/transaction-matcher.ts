// Transaction matching stub (not implemented yet).
// Provides matching functionality between balance and order transactions.

export interface TransactionMatch {
  readonly balanceTransactionId: string;
  readonly orderTransactionId: string | null;
  readonly matched: boolean;
  readonly reason: string;
}

export function matchTransaction(balanceId: string, orderIds: string[]): TransactionMatch {
  // Stub: not implemented yet
  return {
    balanceTransactionId: balanceId,
    orderTransactionId: null,
    matched: false,
    reason: "stub",
  };
}
