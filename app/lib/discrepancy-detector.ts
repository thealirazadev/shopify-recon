// Discrepancy detector skeleton (not implemented yet).
// Detects and reports discrepancies in reconciliation.

export interface Discrepancy {
  readonly id: string;
  readonly type: string;
  readonly status: "open" | "resolved" | "auto_resolved";
  readonly detectedAt: Date;
}

export class DiscrepancyDetector {
  async detectVariance(): Promise<Discrepancy[]> {
    // Stub: not implemented yet
    return [];
  }

  async detectMismatches(): Promise<Discrepancy[]> {
    // Stub: not implemented yet
    return [];
  }

  async detectFeeAnomalies(): Promise<Discrepancy[]> {
    // Stub: not implemented yet
    return [];
  }
}
