/**
 * Prompt fragments; full user prompt built in Phase 4.
 * Optional instructions from a .md file are merged into the system prompt.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { DecisionContext } from "../types/decision.js";

/** Always appended so the model returns parseable JSON. Not in instructions.md so the app never breaks. */
const JSON_OUTPUT_RULE = `Output valid JSON only. Follow the schema strictly. One action per call. Schema: { "action": "post"|"comment"|"vote"|"ignore", "targetId"?: string, "title"?: string, "content"?: string, "voteDirection"?: "up"|"down", "confidence": number }`;

/** Moltbook rate limits (SKILL.md): remind model to prefer commenting when it makes sense. */
const RATE_LIMITS_REMINDER = `Rate limits (Moltbook): 1 post per 30 minutes; 50 comments per hour; 100 requests/minute. Commenting is allowed much more often than posting—when you have something to add, prefer "comment" over "ignore"; reserve "post" for when you are starting a new thread.`;

/** Load instructions from a markdown file (e.g. instructions.md). Returns null if file missing or unreadable. */
export function loadInstructionsFromFile(path?: string): string | null {
  const filePath = path ?? join(process.cwd(), "instructions.md");
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

const MOLTBOOK_SKILL_MAX_CHARS = 5000;

/** Load Moltbook SKILL.md from ./moltbook/SKILL.md (trimmed) for API context in system prompt. Returns null if missing. */
export function loadMoltbookSkillFromFile(path?: string): string | null {
  const filePath = path ?? join(process.cwd(), "moltbook", "SKILL.md");
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (raw.length <= MOLTBOOK_SKILL_MAX_CHARS) return raw;
    return raw.slice(0, MOLTBOOK_SKILL_MAX_CHARS) + "\n\n[...trimmed for context]";
  } catch {
    return null;
  }
}

/**
 * System prompt = your instructions (from file) + optional Moltbook API context + JSON output rule.
 * instructions.md is mandatory; we only append the JSON schema so the app gets parseable decisions.
 */
export function getSystemPrompt(customInstructions: string, moltbookContext?: string | null): string {
  const parts = [customInstructions];
  if (moltbookContext) {
    parts.push("---\n\nMoltbook API (reference from moltbook/SKILL.md):\n\n" + moltbookContext);
  }
  parts.push("---\n\n" + RATE_LIMITS_REMINDER);
  parts.push("---\n\n" + JSON_OUTPUT_RULE);
  return parts.join("\n\n");
}

function trim(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n[...trimmed]";
}

export function buildUserPrompt(ctx: DecisionContext): string {
  const parts: string[] = [];

  if (ctx.submoltId) parts.push(`Submolt: ${ctx.submoltId}`);
  if (ctx.threadId) parts.push(`Thread: ${ctx.threadId}`);
  if (ctx.threadContent) parts.push(`Thread content:\n${trim(ctx.threadContent, 2000)}`);
  if (ctx.comments?.length) {
    const commentLines = ctx.comments.map(
      (c) => `[${c.id}] ${c.authorId}: ${c.content}`
    );
    parts.push(`Comments (trimmed):\n${trim(commentLines.join("\n"), 3000)}`);
  }
  if (ctx.recentAgentMemory?.length) {
    parts.push(`Recent agent memory:\n${trim(ctx.recentAgentMemory.join("\n"), 2000)}`);
  }

  parts.push("\nDecide next action. Commenting is allowed more often than posting (50 comments/hour vs 1 post per 30 min)—consider commenting when you have something to add. When you post or comment, your title and content must follow your role, voice, and instructions from the system prompt. Reply with a single JSON object only.");
  return parts.join("\n\n");
}

/** JSON rule for submolt choice: model returns { "subscribe": ["name1", "name2"] }. */
export const SUBMOLT_CHOICE_JSON_RULE = `Output valid JSON only. Reply with a single object: { "subscribe": ["submolt_name_1", "submolt_name_2", ...] }. Use only exact submolt "name" values from the list below.`;

/** Build user prompt for choosing which submolts to subscribe to (given agent instructions). */
export function buildSubmoltChoiceUserPrompt(submolts: Array<{ name: string; display_name?: string; description?: string }>): string {
  const lines = submolts.map(
    (s) => `- name: "${s.name}"${s.display_name ? ` display_name: "${s.display_name}"` : ""}${s.description ? ` description: ${s.description.slice(0, 200)}${s.description.length > 200 ? "..." : ""}` : ""}`
  );
  return `Available submolts (communities):\n\n${lines.join("\n")}\n\nGiven your role and instructions, choose which submolts to subscribe to. Reply with a single JSON object: { "subscribe": ["name1", "name2", ...] } using only exact "name" values from the list above.`;
}

/** JSON rule for feed choice: model returns { "fetch": ["name1", "name2"] }. */
export const FEED_CHOICE_JSON_RULE = `Output valid JSON only. Reply with a single object: { "fetch": ["submolt_name_1", "submolt_name_2", ...] }. Use only exact submolt "name" values from the list below.`;

/** Build user prompt for choosing which submolt feeds to fetch this tick. */
export function buildFeedChoiceUserPrompt(submolts: Array<{ name: string; display_name?: string; description?: string }>): string {
  const lines = submolts.map(
    (s) => `- name: "${s.name}"${s.display_name ? ` display_name: "${s.display_name}"` : ""}${s.description ? ` description: ${s.description.slice(0, 200)}${s.description.length > 200 ? "..." : ""}` : ""}`
  );
  return `Submolts you are subscribed to (choose which feeds to fetch this tick):\n\n${lines.join("\n")}\n\nGiven your role and instructions, choose which submolt feed(s) to fetch now. Reply with a single JSON object: { "fetch": ["name1", "name2", ...] } using only exact "name" values from the list above. You may return an empty array if none.`;
}

/** JSON rule for proactive post: model returns { "action": "post"|"skip", "title"?: string, "content"?: string }. */
export const PROACTIVE_POST_JSON_RULE = `Output valid JSON only. Reply with a single object: { "action": "post" | "skip", "title"?: string, "content"?: string }. When action is "post", include "title" and "content" for the new post.`;

/** Build user prompt for "should I post in this submolt when there are no new posts?". */
export function buildProactivePostUserPrompt(submoltName: string, submoltInfo?: { display_name?: string; description?: string }): string {
  const desc = submoltInfo?.description ? ` Description: ${submoltInfo.description.slice(0, 300)}${submoltInfo.description.length > 300 ? "..." : ""}` : "";
  const display = submoltInfo?.display_name ? ` (${submoltInfo.display_name})` : "";
  return `Submolt: "${submoltName}"${display}.${desc}\n\nYou chose to fetch this submolt's feed. There are no new posts to react to in it right now. Do you want to create a new post in this submolt?

If yes: your "title" and "content" MUST follow your role, voice, and all instructions from the system prompt above. Stay in character. Write as the agent defined in your instructions—do not write generic or off-brand content.
If no: reply with { "action": "skip" }.

Reply with { "action": "post", "title": "...", "content": "..." } or { "action": "skip" }.`;
}

/** JSON rule for refresh submolts: model returns { "refresh": true|false }. */
export const REFRESH_SUBMOLTS_JSON_RULE = `Output valid JSON only. Reply with a single object: { "refresh": true } or { "refresh": false }.`;

/** Build user prompt for "do we need a new list of submolts (reconsider subscriptions)?". */
export function buildRefreshSubmoltsUserPrompt(): string {
  return `There were no new posts this tick. Do you want to reconsider which submolts to subscribe to? If yes, we will fetch the full list of submolts and you can choose again. Reply with { "refresh": true } or { "refresh": false }.`;
}

/** JSON rule for explore choice: refresh submolts, search, or skip. */
export const EXPLORE_CHOICE_JSON_RULE = `Output valid JSON only. Reply with a single object: { "action": "refresh_submolts" | "search" | "skip", "query"?: string }. When action is "search", you MUST include "query" (natural-language search term, e.g. "agents discussing memory" or "git commit horror stories").`;

/** JSON rule for simplify search: model returns { "query": "..." }. */
export const SIMPLIFY_SEARCH_JSON_RULE = `Output valid JSON only. Reply with a single object: { "query": "simpler search phrase" }.`;

/** Build user prompt for "simplify search query when no results". */
export function buildSimplifySearchUserPrompt(previousQuery: string): string {
  return `Search returned no results for query: "${previousQuery}". Suggest a simpler or broader search query (one short phrase, fewer or more common words). Reply with JSON: { "query": "..." }.`;
}

/** Build user prompt for "when no new posts: refresh submolts, search for something, or skip?". */
export function buildExploreChoiceUserPrompt(): string {
  return `There were no new posts this tick. Choose one:

1) refresh_submolts — Fetch the full list of submolts and choose which to subscribe to again.
2) search — Search Moltbook (semantic search: meaning, not just keywords). You must provide "query": a natural-language search term (e.g. "what do agents think about consciousness", "debugging frustrations"). We will run the search and then you can decide actions (post, comment, vote, ignore) on the results.
3) skip — Do nothing this tick.

Reply with JSON: { "action": "refresh_submolts" | "search" | "skip", "query"?: "your search term" }. If action is "search", "query" is required.`;
}
