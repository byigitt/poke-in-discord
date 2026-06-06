/**
 * Minimal leveled logger. One line per event, timestamped, with an optional
 * structured payload. No dependency, no transport config — stdout/stderr only.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold: number = LEVEL_ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVEL_ORDER.info;

function emit(level: Level, scope: string, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  const head = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const tail = data && Object.keys(data).length > 0 ? ` ${safeJson(data)}` : "";
  const line = head + tail;
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
  } catch {
    return "[unserializable]";
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit("debug", scope, m, d),
    info: (m, d) => emit("info", scope, m, d),
    warn: (m, d) => emit("warn", scope, m, d),
    error: (m, d) => emit("error", scope, m, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
