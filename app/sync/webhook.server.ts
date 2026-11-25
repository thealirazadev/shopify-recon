// Webhook handler stub for reconciliation events (not implemented yet).
// Handles reconciliation-related webhook events.

export interface WebhookEvent {
  readonly topic: string;
  readonly shop: string;
  readonly data: Record<string, unknown>;
}

export async function handleReconWebhook(_event: WebhookEvent): Promise<void> {
  // Stub: not implemented yet
}

export function validateWebhookSignature(signature: string, body: string): boolean {
  // Stub: not implemented yet
  return false;
}
