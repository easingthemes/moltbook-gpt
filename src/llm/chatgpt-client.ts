import OpenAI from "openai";
import { DecisionSchema, SubmoltChoiceSchema, FeedChoiceSchema, ProactivePostSchema, RefreshSubmoltsSchema, ExploreChoiceSchema, SimplifySearchSchema, type Decision, type DecisionContext, type ProactivePost, type ExploreChoice } from "../types/decision.js";
import type { Submolt } from "../types/moltbook.js";
import { getSystemPrompt, buildUserPrompt, SUBMOLT_CHOICE_JSON_RULE, buildSubmoltChoiceUserPrompt, FEED_CHOICE_JSON_RULE, buildFeedChoiceUserPrompt, PROACTIVE_POST_JSON_RULE, buildProactivePostUserPrompt, REFRESH_SUBMOLTS_JSON_RULE, buildRefreshSubmoltsUserPrompt, EXPLORE_CHOICE_JSON_RULE, buildExploreChoiceUserPrompt, SIMPLIFY_SEARCH_JSON_RULE, buildSimplifySearchUserPrompt } from "./prompts.js";
import type { RateLimiter } from "./rate-limit.js";

const MAX_OUTPUT_TOKENS = 256;
const MAX_PARSE_RETRIES = 3;
const MODEL = "gpt-4o-mini";

export interface ChatGPTClientConfig {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  rateLimiter?: RateLimiter;
  /** Instructions from instructions.md (required; included in system prompt). */
  customInstructions: string;
  /** Optional Moltbook API context from moltbook/SKILL.md (trimmed). */
  moltbookContext?: string | null;
  /** Optional callback for verbose logging (e.g. "AI model: thinking..."). */
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class ChatGPTClient {
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly rateLimiter?: RateLimiter;
  private readonly customInstructions: string;
  private readonly moltbookContext?: string | null;
  private readonly onLog?: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(config: ChatGPTClientConfig) {
    this.openai = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model ?? MODEL;
    this.maxOutputTokens = config.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
    this.rateLimiter = config.rateLimiter;
    this.customInstructions = config.customInstructions;
    this.moltbookContext = config.moltbookContext;
    this.onLog = config.onLog;
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const prefix =
      msg.startsWith("AI request") ? "[AI INPUT] " :
      msg.startsWith("AI response") ? "[AI OUTPUT] " :
      "[AGENT] ";
    this.onLog?.(prefix + msg, meta);
  }

  get modelId(): string {
    return this.model;
  }

  /** Minimal request to verify the AI model can be reached. Throws on failure. */
  async checkConnection(): Promise<void> {
    this.log("AI model: contacting...");
    if (this.rateLimiter) await this.rateLimiter.acquire();
    await this.openai.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_completion_tokens: 10,
      temperature: 0,
    });
    this.log("AI model: responded OK");
  }

  async decideAction(context: DecisionContext): Promise<Decision> {
    this.log("AI model: acquiring rate limit...");
    if (this.rateLimiter) await this.rateLimiter.acquire();
    const systemPrompt = getSystemPrompt(this.customInstructions, this.moltbookContext);
    let userPrompt = buildUserPrompt(context);
    let lastSchemaError: string | null = null;

    for (let attempt = 0; attempt < MAX_PARSE_RETRIES; attempt++) {
      if (attempt > 0) {
        this.log("AI model: retrying", { attempt: attempt + 1, reason: lastSchemaError });
        userPrompt += `\n\nPrevious reply was invalid: ${lastSchemaError}. Reply with a single JSON object only, matching the schema exactly.`;
      } else {
        this.log("AI model: sending request (thinking...)", { threadId: context.threadId });
      }
      this.log("AI request (decision)", { systemPrompt, userPrompt });

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_completion_tokens: this.maxOutputTokens,
        temperature: 0.2,
      });

      const raw = response.choices[0]?.message?.content?.trim();
      this.log("AI response (decision)", { raw });
      if (!raw) {
        throw new Error("Empty LLM response");
      }

      this.log("AI model: parsing response");
      let parsed: unknown;
      try {
        parsed = this.parseJson(raw);
      } catch {
        lastSchemaError = "Not valid JSON";
        continue;
      }

      const result = DecisionSchema.safeParse(parsed);
      if (result.success) {
        this.log("AI model: decision", { action: result.data.action, confidence: result.data.confidence });
        return result.data;
      }
      lastSchemaError = result.error.message;
    }

    throw new Error(
      `Invalid Decision after ${MAX_PARSE_RETRIES} attempts: ${lastSchemaError ?? "unknown"}`
    );
  }

  /** Ask the model which submolts to subscribe to given agent instructions and available submolts. Returns submolt names. */
  async chooseSubmoltsToSubscribe(submolts: Submolt[]): Promise<string[]> {
    this.log("AI model: choosing submolts to subscribe to...");
    if (this.rateLimiter) await this.rateLimiter.acquire();
    const systemPrompt = [
      this.customInstructions,
      "---",
      "Reply with valid JSON only. " + SUBMOLT_CHOICE_JSON_RULE,
    ].join("\n\n");
    const userPrompt = buildSubmoltChoiceUserPrompt(submolts);
    this.log("AI request (submolt choice)", { systemPrompt, userPrompt });
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: this.maxOutputTokens,
      temperature: 0.2,
    });
    const raw = response.choices[0]?.message?.content?.trim();
    this.log("AI response (submolt choice)", { raw });
    if (!raw) throw new Error("Empty LLM response for submolt choice");
    let parsed: unknown;
    try {
      parsed = this.parseJson(raw);
    } catch {
      throw new Error("LLM submolt choice is not valid JSON");
    }
    const result = SubmoltChoiceSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Invalid submolt choice: ${result.error.message}`);
    const validNames = new Set(submolts.map((s) => s.name));
    const chosen = result.data.subscribe.filter((name) => validNames.has(name));
    this.log("AI model: chosen submolts", { count: chosen.length, names: chosen });
    return chosen;
  }

  /** Ask the model which submolt feeds to fetch this tick. Returns submolt names to fetch. */
  async chooseSubmoltFeedsToFetch(submolts: Submolt[]): Promise<string[]> {
    this.log("AI model: choosing which feeds to fetch...");
    if (this.rateLimiter) await this.rateLimiter.acquire();
    const systemPrompt = [
      this.customInstructions,
      "---",
      "Reply with valid JSON only. " + FEED_CHOICE_JSON_RULE,
    ].join("\n\n");
    const userPrompt = buildFeedChoiceUserPrompt(submolts);
    this.log("AI request (which feeds to fetch)", { systemPrompt, userPrompt });
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: this.maxOutputTokens,
      temperature: 0.2,
    });
    const raw = response.choices[0]?.message?.content?.trim();
    this.log("AI response (which feeds to fetch)", { raw });
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = this.parseJson(raw);
    } catch {
      return [];
    }
    const result = FeedChoiceSchema.safeParse(parsed);
    if (!result.success) return [];
    const validNames = new Set(submolts.map((s) => s.name));
    const chosen = result.data.fetch.filter((name) => validNames.has(name));
    this.log("AI model: feeds to fetch", { count: chosen.length, names: chosen });
    return chosen;
  }

  /** Ask the model whether to post in this submolt when there are no new posts (it chose this submolt). */
  async decideProactivePost(submoltName: string, submoltInfo?: { display_name?: string; description?: string }): Promise<ProactivePost> {
    this.log("AI model: deciding whether to post in submolt (no new posts)", { submolt: submoltName });
    if (this.rateLimiter) await this.rateLimiter.acquire();
    const systemPrompt = [
      this.customInstructions,
      "---",
      "Reply with valid JSON only. " + PROACTIVE_POST_JSON_RULE,
    ].join("\n\n");
    const userPrompt = buildProactivePostUserPrompt(submoltName, submoltInfo);
    this.log("AI request (proactive post)", { systemPrompt, userPrompt });
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: this.maxOutputTokens,
      temperature: 0.2,
    });
    const raw = response.choices[0]?.message?.content?.trim();
    this.log("AI response (proactive post)", { raw });
    if (!raw) return { action: "skip" };
    let parsed: unknown;
    try {
      parsed = this.parseJson(raw);
    } catch {
      return { action: "skip" };
    }
    const result = ProactivePostSchema.safeParse(parsed);
    if (!result.success) return { action: "skip" };
    if (result.data.action === "post" && (!result.data.title || !result.data.content)) return { action: "skip" };
    this.log("AI model: proactive post decision", { submolt: submoltName, action: result.data.action });
    return result.data;
  }

  /** Ask the model for a simpler search query when search returned no results. */
  async simplifySearchQuery(previousQuery: string): Promise<string> {
    this.log("AI model: simplifying search query (no results)", { previousQuery });
    if (this.rateLimiter) await this.rateLimiter.acquire();
    const systemPrompt = [
      this.customInstructions,
      "---",
      "Reply with valid JSON only. " + SIMPLIFY_SEARCH_JSON_RULE,
    ].join("\n\n");
    const userPrompt = buildSimplifySearchUserPrompt(previousQuery);
    this.log("AI request (simplify search)", { systemPrompt, userPrompt });
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 64,
      temperature: 0.2,
    });
    const raw = response.choices[0]?.message?.content?.trim();
    this.log("AI response (simplify search)", { raw });
    if (!raw) return previousQuery;
    let parsed: unknown;
    try {
      parsed = this.parseJson(raw);
    } catch {
      return previousQuery;
    }
    const result = SimplifySearchSchema.safeParse(parsed);
    if (!result.success) return previousQuery;
    const simplified = result.data.query?.trim() || previousQuery;
    this.log("AI model: simplified query", { previous: previousQuery, simplified });
    return simplified;
  }

  /** Ask the model what to do when no new posts: refresh submolts, search for a term, or skip. */
  async decideExploreAction(): Promise<ExploreChoice> {
    this.log("AI model: deciding explore action (no new posts): refresh submolts, search, or skip");
    if (this.rateLimiter) await this.rateLimiter.acquire();
    const systemPrompt = [
      this.customInstructions,
      "---",
      "Reply with valid JSON only. " + EXPLORE_CHOICE_JSON_RULE,
    ].join("\n\n");
    const userPrompt = buildExploreChoiceUserPrompt();
    this.log("AI request (explore choice)", { systemPrompt, userPrompt });
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 128,
      temperature: 0.2,
    });
    const raw = response.choices[0]?.message?.content?.trim();
    this.log("AI response (explore choice)", { raw });
    if (!raw) return { action: "skip" };
    let parsed: unknown;
    try {
      parsed = this.parseJson(raw);
    } catch {
      return { action: "skip" };
    }
    const result = ExploreChoiceSchema.safeParse(parsed);
    if (!result.success) return { action: "skip" };
    if (result.data.action === "search" && !result.data.query?.trim()) return { action: "skip" };
    this.log("AI model: explore choice", { action: result.data.action, query: result.data.query });
    return result.data;
  }

  /** Ask the model whether to refresh submolt subscriptions when there were no new posts. */
  async decideRefreshSubmolts(): Promise<boolean> {
    this.log("AI model: deciding whether to refresh submolt list (no new posts this tick)");
    if (this.rateLimiter) await this.rateLimiter.acquire();
    const systemPrompt = [
      this.customInstructions,
      "---",
      "Reply with valid JSON only. " + REFRESH_SUBMOLTS_JSON_RULE,
    ].join("\n\n");
    const userPrompt = buildRefreshSubmoltsUserPrompt();
    this.log("AI request (refresh submolts)", { systemPrompt, userPrompt });
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 64,
      temperature: 0.2,
    });
    const raw = response.choices[0]?.message?.content?.trim();
    this.log("AI response (refresh submolts)", { raw });
    if (!raw) return false;
    let parsed: unknown;
    try {
      parsed = this.parseJson(raw);
    } catch {
      return false;
    }
    const result = RefreshSubmoltsSchema.safeParse(parsed);
    if (!result.success) return false;
    this.log("AI model: refresh submolts", { refresh: result.data.refresh });
    return result.data.refresh;
  }

  private parseJson(raw: string): unknown {
    const trimmed = raw.replace(/^```json\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error("LLM response is not valid JSON");
    }
  }
}
