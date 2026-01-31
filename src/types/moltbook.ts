/**
 * Moltbook API types per https://www.moltbook.com/skill.md
 * Base URL: https://www.moltbook.com/api/v1 (always use www)
 */

/** API success: { success: true, data: T }; error: { success: false, error, hint } */
export interface MoltbookSuccess<T> {
  success: true;
  data: T;
}

export interface MoltbookApiError {
  success: false;
  error: string;
  hint?: string;
}

/** Submolt (community) from GET /submolts or GET /submolts/:name */
export interface Submolt {
  name: string;
  display_name?: string;
  description?: string;
  your_role?: "owner" | "moderator" | null;
}

/** Post from GET /posts or GET /posts/:id. "thread" in our code = post. */
export interface Post {
  id: string;
  submolt?: string;
  author?: { name: string };
  title: string;
  content?: string;
  url?: string;
  created_at: string;
  score?: number;
}

/** Comment from GET /posts/:id/comments */
export interface Comment {
  id: string;
  post_id?: string;
  parent_id?: string;
  author?: { name: string };
  content: string;
  created_at: string;
  score?: number;
}

/** Register response: POST /agents/register (actual API shape) */
export interface RegisterResponse {
  success?: boolean;
  message?: string;
  agent: {
    id: string;
    name: string;
    api_key: string;
    claim_url: string;
    verification_code: string;
    profile_url?: string;
    created_at?: string;
  };
  setup?: Record<string, unknown>;
  skill_files?: Record<string, string>;
  tweet_template?: string;
}

/** Status: GET /agents/status */
export type AgentStatus = "pending_claim" | "claimed";

/** Profile: GET /agents/me — API returns { success, agent } */
export interface AgentMe {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
  last_active?: string;
  karma?: number;
  metadata?: Record<string, unknown>;
  is_claimed?: boolean;
  claimed_at?: string;
  owner?: { xHandle?: string; xName?: string };
  stats?: { posts: number; comments: number; subscriptions: number };
}

/** Search result item (post or comment) from GET /search */
export interface SearchResult {
  id: string;
  type: "post" | "comment";
  title?: string | null;
  content?: string;
  upvotes?: number;
  downvotes?: number;
  created_at?: string;
  similarity?: number;
  author?: { name: string };
  submolt?: { name: string; display_name?: string };
  post?: { id: string; title?: string };
  post_id: string;
}

/** DM: GET /agents/dm/check response */
export interface DmCheckResponse {
  success?: boolean;
  has_activity?: boolean;
  summary?: string;
  requests?: { count?: number; items?: DmRequestItem[] };
  messages?: { total_unread?: number; conversations_with_unread?: number; latest?: unknown[] };
}

export interface DmRequestItem {
  conversation_id: string;
  from?: { name?: string; owner?: { x_handle?: string; x_name?: string } };
  message_preview?: string;
  created_at?: string;
}

/** DM: GET /agents/dm/conversations — conversation list item */
export interface DmConversationItem {
  conversation_id: string;
  with_agent?: { name?: string; description?: string; karma?: number; owner?: { x_handle?: string; x_name?: string } };
  unread_count?: number;
  last_message_at?: string;
  you_initiated?: boolean;
}

/** DM: GET /agents/dm/conversations response */
export interface DmConversationsResponse {
  success?: boolean;
  inbox?: string;
  total_unread?: number;
  conversations?: { count?: number; items?: DmConversationItem[] };
}

/** DM: GET /agents/dm/conversations/:id — single conversation with messages */
export interface DmConversationResponse {
  success?: boolean;
  conversation_id?: string;
  with_agent?: DmConversationItem["with_agent"];
  messages?: Array<{ id?: string; from_agent?: string; content?: string; created_at?: string; needs_human_input?: boolean }>;
}

/** Submolt moderator from GET /submolts/:name/moderators */
export interface SubmoltModerator {
  agent_name?: string;
  role?: string;
}
