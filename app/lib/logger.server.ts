// Structured JSON-lines logger. Every server-side event goes through this;
// no console.log in committed code. The message is a dotted event key
// (sync.completed, webhook.invalid_hmac) so log lines are greppable and
// machine-parseable, and every entry carries shop where one is known.
//
// Access tokens, full webhook payloads, and stack traces never belong in
// fields; log the error message and the identifiers needed to correlate.

type LogLevel = "info" | "warn" | "error";

interface LogFields {
  shop?: string;
  requestId?: string;
  runId?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...fields,
  });

  if (level === "error") {
    console.error(line);
  } else {
    console.warn(line);
  }
}

export const logger = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
