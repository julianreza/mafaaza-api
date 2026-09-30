type Level = "debug" | "info" | "warn" | "error";

const silent = process.env.LOG_LEVEL === "silent";

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (silent) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/** Minimal structured JSON logger (one line per event). Never pass secrets in `fields`. */
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
