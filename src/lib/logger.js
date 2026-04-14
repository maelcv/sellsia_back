/**
 * Structured JSON logger for Sellsia Dashboard API.
 * Emits newline-delimited JSON to stdout/stderr for Railway log ingestion.
 */

export const logger = {
  info(msg, meta = {}) {
    console.log(JSON.stringify({ level: "info", msg, ...meta, ts: Date.now() }));
  },
  warn(msg, meta = {}) {
    console.warn(JSON.stringify({ level: "warn", msg, ...meta, ts: Date.now() }));
  },
  error(msg, err, meta = {}) {
    console.error(
      JSON.stringify({
        level: "error",
        msg,
        error: err?.message,
        stack: err?.stack?.slice(0, 500),
        ...meta,
        ts: Date.now(),
      })
    );
  },
};
