// Status enums for Phase 3 reconciliation states.
// Defines all possible status values used in the recon system.

export const MatchStatus = {
  MATCHED: "matched",
  PARTIAL: "partial",
  UNMATCHED: "unmatched",
} as const;

export const DiscrepancyStatus = {
  OPEN: "open",
  RESOLVED: "resolved",
  AUTO_RESOLVED: "auto_resolved",
} as const;

export const ReconStatus = {
  PENDING: "pending",
  RECONCILED: "reconciled",
  VARIANCE: "variance",
} as const;

export const PayoutStatus = {
  SCHEDULED: "scheduled",
  IN_TRANSIT: "in_transit",
  PAID: "paid",
  FAILED: "failed",
  CANCELED: "canceled",
} as const;

export type MatchState = (typeof MatchStatus)[keyof typeof MatchStatus];
export type DiscrepancyStatusType = (typeof DiscrepancyStatus)[keyof typeof DiscrepancyStatus];
export type ReconStatusType = (typeof ReconStatus)[keyof typeof ReconStatus];
export type PayoutStatusType = (typeof PayoutStatus)[keyof typeof PayoutStatus];
