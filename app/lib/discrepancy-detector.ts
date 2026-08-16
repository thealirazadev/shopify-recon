// Discrepancy detector skeleton for Phase 3.
// Detects and reports discrepancies in reconciliation.

export interface Discrepancy {
  readonly id: string;
  readonly type: string;
  readonly status: "open" | "resolved" | "auto_resolved";
  readonly detectedAt: Date;
}

export class DiscrepancyDetector {
  async detectVariance(): Promise<Discrepancy[]> {
    // Stub: to be implemented in Phase 3
    return [];
  }

  async detectMismatches(): Promise<Discrepancy[]> {
    // Stub: to be implemented in Phase 3
    return [];
  }

  async detectFeeAnomalies(): Promise<Discrepancy[]> {
    // Stub: to be implemented in Phase 3
    return [];
  }
}
