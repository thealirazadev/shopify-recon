// Re-syncing unchanged upstream data must be a true no-op, and Prisma's
// @updatedAt bumps on any update call even when no column value changes. So
// every mirror write compares the mapped row against the stored one first and
// skips the write when they agree. Pure and unit-testable.

function sameValue(stored: unknown, mapped: unknown): boolean {
  if (stored instanceof Date && mapped instanceof Date) {
    return stored.getTime() === mapped.getTime();
  }

  return stored === mapped;
}

/**
 * True when every field of `next` already equals its counterpart on
 * `existing`. Fields absent from `next` are not compared, so callers pass only
 * the columns the sync owns and never the derived or operator-owned ones.
 */
export function isUnchanged(existing: object, next: object): boolean {
  const row = existing as Record<string, unknown>;

  for (const [key, value] of Object.entries(next)) {
    if (!sameValue(row[key], value)) {
      return false;
    }
  }

  return true;
}
