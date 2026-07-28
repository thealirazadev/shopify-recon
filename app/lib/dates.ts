// Payout periods are calendar dates in the shop's timezone, not UTC. This
// module is the only place a UTC instant becomes a shop-local calendar date
// or the reverse. Pure: no Date.now(), no timezone library, Intl only.

export class InvalidTimeZoneError extends Error {
  constructor(readonly timeZone: string) {
    super(`Unknown IANA timezone: ${timeZone}`);
    this.name = "InvalidTimeZoneError";
  }
}

export class InvalidShopDateError extends Error {
  constructor(readonly value: string) {
    super(`Invalid shop-local date "${value}": expected YYYY-MM-DD`);
    this.name = "InvalidShopDateError";
  }
}

export interface ShopDateRange {
  /** UTC instant of the first moment of the local `from` day. */
  readonly start: Date;
  /** UTC instant of the first moment of the day after the local `to` day. */
  readonly endExclusive: Date;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);

  if (cached) {
    return cached;
  }

  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }

  formatterCache.set(timeZone, formatter);

  return formatter;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localPartsOf(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const local = localPartsOf(instant, timeZone);
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );

  return asIfUtc - instant.getTime();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Shop-local calendar date (YYYY-MM-DD) of a UTC instant. This is the value
 * stored on Payout.payoutDate and used by every filter, grouping, and CSV
 * period boundary.
 */
export function payoutDate(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidShopDateError("Invalid Date");
  }

  const local = localPartsOf(instant, timeZone);

  return `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`;
}

function parseShopDate(value: string): number {
  const match = DATE_PATTERN.exec(value);

  if (!match) {
    throw new InvalidShopDateError(value);
  }

  const [, year, month, day] = match;
  const utcMidnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const roundTrip = new Date(utcMidnight);

  // Rejects impossible dates such as 2026-02-30, which Date.UTC rolls over.
  if (
    roundTrip.getUTCFullYear() !== Number(year) ||
    roundTrip.getUTCMonth() !== Number(month) - 1 ||
    roundTrip.getUTCDate() !== Number(day)
  ) {
    throw new InvalidShopDateError(value);
  }

  return utcMidnight;
}

/**
 * UTC instant of the first moment of a shop-local calendar day. Two passes
 * settle the offset, because the offset that applies depends on the instant
 * being computed. On a spring-forward day whose local midnight does not
 * exist, this lands on the first moment that does.
 */
function startOfShopDay(utcMidnight: number, timeZone: string): Date {
  let instant = utcMidnight;

  for (let pass = 0; pass < 2; pass++) {
    instant = utcMidnight - zoneOffsetMs(new Date(instant), timeZone);
  }

  return new Date(instant);
}

/**
 * Half-open UTC bounds of an inclusive shop-local date range, for querying
 * instants (issuedAt, processedAt) by shop-local calendar dates.
 */
export function shopDateRange(from: string, to: string, timeZone: string): ShopDateRange {
  const fromMidnight = parseShopDate(from);
  const toMidnight = parseShopDate(to);

  if (toMidnight < fromMidnight) {
    throw new InvalidShopDateError(`${from}..${to}`);
  }

  return {
    start: startOfShopDay(fromMidnight, timeZone),
    endExclusive: startOfShopDay(toMidnight + MS_PER_DAY, timeZone),
  };
}
