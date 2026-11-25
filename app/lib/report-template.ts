// Reconciliation report template (not implemented yet).
// Defines the structure of reconciliation reports.

export interface ReportSection {
  readonly title: string;
  readonly content: string;
}

export interface ReconciliationReport {
  readonly shopId: string;
  readonly reportDate: Date;
  readonly sections: ReportSection[];
  readonly status: "draft" | "final";
}

export function createReportTemplate(): ReconciliationReport {
  // Stub: not implemented yet
  return {
    shopId: "",
    reportDate: new Date(),
    sections: [],
    status: "draft",
  };
}

export function formatReport(report: ReconciliationReport): string {
  // Stub: not implemented yet
  return "";
}
