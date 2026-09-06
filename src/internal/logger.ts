/**
 * The smallest logging seam that lets a host route this package's output
 * somewhere real.
 *
 * Before this, three `console.error` calls were the entire error-reporting
 * story — invisible to any structured logging pipeline, and unsuppressable in
 * tests. This adds no dependency and no configuration beyond one optional
 * option.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const PREFIX = "[mastra-multiplayer]";

/** Writes to `console`, which is what a host with no logger already had. */
export const consoleLogger: Logger = {
  debug: (message, context) => emit("debug", message, context),
  info: (message, context) => emit("info", message, context),
  warn: (message, context) => emit("warn", message, context),
  error: (message, context) => emit("error", message, context),
};

/** Discards everything. Useful in tests, and for a host that wants silence. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function emit(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
): void {
  const method = level === "debug" ? "log" : level;
  if (context === undefined) console[method](`${PREFIX} ${message}`);
  else console[method](`${PREFIX} ${message}`, context);
}

/**
 * Wraps a logger so its own failure cannot take down the caller.
 *
 * A logger is passed in by the host and may do anything — write to a socket,
 * serialize a circular object. Publishing an event should not fail because
 * shipping a log line did.
 */
export function safeLogger(logger: Logger): Logger {
  const guard =
    (level: keyof Logger) =>
    (message: string, context?: Record<string, unknown>): void => {
      try {
        logger[level](message, context);
      } catch {
        // Nothing useful to do here; reporting a logging failure needs a logger.
      }
    };

  return {
    debug: guard("debug"),
    info: guard("info"),
    warn: guard("warn"),
    error: guard("error"),
  };
}
