/**
 * Append [AI INPUT] and [AI OUTPUT] logs to ./logs/DATE-N.txt.
 * Rotates to a new file when the current file would exceed MAX_LINES_PER_FILE.
 */
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const LOGS_DIR = join(process.cwd(), "logs");
const MAX_LINES_PER_FILE = 5000;
const TRUNCATE_PROMPT_TO = 300;

function truncatePrompt(s: unknown): unknown {
  if (typeof s !== "string") return s;
  if (s.length <= TRUNCATE_PROMPT_TO) return s;
  return s.slice(0, TRUNCATE_PROMPT_TO) + "...";
}

/** Truncate systemPrompt and userPrompt to TRUNCATE_PROMPT_TO chars. Export for use in console logs. */
export function truncateMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out = { ...meta };
  if (typeof out.systemPrompt === "string") {
    out.systemPrompt = truncatePrompt(out.systemPrompt);
  }
  if (typeof out.userPrompt === "string") {
    out.userPrompt = truncatePrompt(out.userPrompt);
  }
  return out;
}

let currentDate = "";
let currentIndex = 1;
let currentLineCount = 0;

function getDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function getCurrentFilePath(): string {
  const date = getDateString();
  if (date !== currentDate) {
    currentDate = date;
    currentIndex = 1;
    currentLineCount = 0;
  }
  return join(LOGS_DIR, `${currentDate}-${currentIndex}.txt`);
}

function rotateIfNeeded(linesToAdd: number): void {
  if (currentLineCount + linesToAdd > MAX_LINES_PER_FILE) {
    currentIndex++;
    currentLineCount = 0;
  }
}

/**
 * Append one AI log entry (header + optional meta line).
 * Each entry is 1 line (msg) or 2 lines (msg + meta JSON).
 */
export function appendAILog(msg: string, meta?: Record<string, unknown>): void {
  if (!msg.startsWith("[AI INPUT]") && !msg.startsWith("[AI OUTPUT]")) {
    return;
  }
  const ts = new Date().toISOString();
  const header = `${ts} ${msg}\n`;
  const metaLine = meta != null ? `${JSON.stringify(meta)}\n` : "";
  const linesToAdd = metaLine ? 2 : 1;

  ensureLogsDir();
  rotateIfNeeded(linesToAdd);
  const filePath = getCurrentFilePath();
  appendFileSync(filePath, header + metaLine, "utf-8");
  currentLineCount += linesToAdd;
}
