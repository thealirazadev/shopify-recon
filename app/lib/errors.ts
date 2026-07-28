// The one JSON error shape every loader and action returns, per
// docs/api-contracts.md. message is friendly and safe to show; requestId
// correlates with the server log line that carries the full detail.
//
// Discrepancies and match failures are not errors in this format: a payout
// that does not reconcile is a successful response carrying data.

export type ErrorCode =
  "UNAUTHENTICATED" | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "UPSTREAM_ERROR" | "INTERNAL";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

export function newRequestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

export function apiError(code: ErrorCode, message: string, requestId: string): ApiErrorBody {
  return { error: { code, message, requestId } };
}
