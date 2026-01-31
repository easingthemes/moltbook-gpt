import type { EnvConfig } from "../types/index.js";

const required = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
};

const num = (name: string, defaultVal: number): number => {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultVal;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number for env ${name}: ${v}`);
  return n;
};

const bool = (name: string, defaultVal: boolean): boolean => {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultVal;
  return v.toLowerCase() === "true" || v === "1";
};

export function loadEnv(): EnvConfig {
  const TICK_INTERVAL_MINUTES = num("TICK_INTERVAL_MINUTES", 5);
  const postInterval = num("POST_INTERVAL_MINUTES", 30);
  const POST_INTERVAL_MINUTES = postInterval < 30 ? 30 : postInterval;

  return {
    OPENAI_API_KEY: required("OPENAI_API_KEY"),
    OPENAI_MODEL: process.env.OPENAI_MODEL || undefined,
    MOLTBOOK_API_KEY: required("MOLTBOOK_API_KEY"),
    MOLTBOOK_API_URL: process.env.MOLTBOOK_API_URL,
    MOLTBOOK_USE_MOCKS: bool("MOLTBOOK_USE_MOCKS", false),
    AGENT_NAME: required("AGENT_NAME"),
    TICK_INTERVAL_MINUTES: TICK_INTERVAL_MINUTES < 1 ? 1 : TICK_INTERVAL_MINUTES,
    POST_INTERVAL_MINUTES,
    USE_PERSONALIZED_FEED: bool("USE_PERSONALIZED_FEED", false),
    DRY_RUN: bool("DRY_RUN", false),
    KILL_SWITCH: bool("KILL_SWITCH", false),
  };
}
