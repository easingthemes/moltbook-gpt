/**
 * Shared types for the Moltbook ↔ ChatGPT agent.
 */

export type { Decision, DecisionContext } from "./decision.js";
export { DecisionSchema } from "./decision.js";

export interface EnvConfig {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  MOLTBOOK_API_KEY: string;
  MOLTBOOK_API_URL?: string;
  MOLTBOOK_USE_MOCKS?: boolean;
  AGENT_NAME: string;
  /** How often we run a tick (feed check, AI decision). Default 5 min. */
  TICK_INTERVAL_MINUTES: number;
  /** Min minutes between posts to Moltbook (rate limit). Default 30, min 30. */
  POST_INTERVAL_MINUTES: number;
  DRY_RUN?: boolean;
  KILL_SWITCH?: boolean;
  USE_PERSONALIZED_FEED?: boolean;
}
