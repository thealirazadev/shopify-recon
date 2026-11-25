// Reconciliation entity types and interfaces.
// Defines the core reconciliation structures.

export interface OrderReconciliation {
  readonly orderId: string;
  readonly shopifyGid: string;
  readonly reconciliationStatus: "pending" | "complete" | "error";
  readonly processedAt: Date;
}

export interface ReconciliationResult {
  readonly success: boolean;
  readonly message: string;
}
