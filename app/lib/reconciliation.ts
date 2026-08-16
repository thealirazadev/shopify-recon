// Reconciliation entity types and interfaces for Phase 3.
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
