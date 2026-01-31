/**
 * Structured logging for decisions and errors.
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  meta?: Record<string, unknown>;
}

function format(entry: LogEntry): string {
  const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
  return `${entry.ts} [${entry.level}] ${entry.msg}${meta}`;
}

export function createLogger(level: LogLevel = "info") {
  const levels: LogLevel[] = ["info", "warn", "error"];
  const levelIndex = levels.indexOf(level);

  const log = (l: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (levels.indexOf(l) < levelIndex) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level: l,
      msg,
      meta,
    };
    console.log(format(entry));
  };

  return {
    info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
    decision: (input: unknown, output: unknown, outcome?: string) => {
      log("info", "decision", { input: truncate(input), output, outcome });
    },
  };
}

function truncate(obj: unknown, max = 500): unknown {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length <= max) return obj;
  return s.slice(0, max) + "...";
}
