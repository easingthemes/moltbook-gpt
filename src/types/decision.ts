import { z } from "zod";

export const DecisionSchema = z.object({
  action: z.enum(["post", "comment", "vote", "ignore"]),
  targetId: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  voteDirection: z.enum(["up", "down"]).optional(),
  confidence: z.number().min(0).max(1),
});

export type Decision = z.infer<typeof DecisionSchema>;

export interface DecisionContext {
  threadContent?: string;
  comments?: Array<{ id: string; authorId: string; content: string }>;
  recentAgentMemory?: string[];
  submoltId?: string;
  threadId?: string;
}

/** LLM response for "which submolts to subscribe to". */
export const SubmoltChoiceSchema = z.object({
  subscribe: z.array(z.string()).describe("Submolt names to subscribe to (use exact names from the list)"),
});
export type SubmoltChoice = z.infer<typeof SubmoltChoiceSchema>;

/** LLM response for "which submolt feeds to fetch this tick". */
export const FeedChoiceSchema = z.object({
  fetch: z.array(z.string()).describe("Submolt names whose feeds to fetch (use exact names from the list)"),
});
export type FeedChoice = z.infer<typeof FeedChoiceSchema>;

/** LLM response for "should I post in this submolt when there are no new posts?". */
export const ProactivePostSchema = z.object({
  action: z.enum(["post", "skip"]),
  title: z.string().optional(),
  content: z.string().optional(),
});
export type ProactivePost = z.infer<typeof ProactivePostSchema>;

/** LLM response for "do we need a new list of submolts (reconsider subscriptions)?". */
export const RefreshSubmoltsSchema = z.object({
  refresh: z.boolean().describe("True if you want to reconsider which submolts to subscribe to"),
});
export type RefreshSubmolts = z.infer<typeof RefreshSubmoltsSchema>;

/** LLM response for "what to do when no new posts: refresh submolts, search, or skip?". */
export const ExploreChoiceSchema = z.object({
  action: z.enum(["refresh_submolts", "search", "skip"]),
  query: z.string().optional().describe("Required when action is 'search': natural-language search term"),
});
export type ExploreChoice = z.infer<typeof ExploreChoiceSchema>;

/** LLM response for "simplify search query when no results". */
export const SimplifySearchSchema = z.object({
  query: z.string().describe("Simpler or broader search phrase"),
});
export type SimplifySearch = z.infer<typeof SimplifySearchSchema>;
