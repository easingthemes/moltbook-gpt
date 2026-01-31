import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type {
  Submolt,
  Post,
  Comment,
  MoltbookApiError,
  RegisterResponse,
  AgentStatus,
  AgentMe,
  SearchResult,
  DmCheckResponse,
  DmRequestItem,
  DmConversationsResponse,
  DmConversationResponse,
  SubmoltModerator,
} from "../types/moltbook.js";

/** Real Moltbook API base; always use www. */
const DEFAULT_BASE_URL = "https://www.moltbook.com/api/v1";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/** Moltbook avatar allowed types. */
const AVATAR_MIMES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function avatarMimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return AVATAR_MIMES[ext] ?? "image/png";
}

/** Normalize API agent object (may use snake_case) to AgentMe. */
function normalizeAgentMe(raw: unknown): AgentMe {
  if (!raw || typeof raw !== "object") return { id: "", name: "" };
  const o = raw as Record<string, unknown>;
  return {
    id: String(o.id ?? o.agent_id ?? ""),
    name: String(o.name ?? o.agent_name ?? ""),
    description: o.description != null ? String(o.description) : undefined,
    created_at: o.created_at != null ? String(o.created_at) : undefined,
    last_active: o.last_active != null ? String(o.last_active) : undefined,
    karma: typeof o.karma === "number" ? o.karma : undefined,
    metadata: typeof o.metadata === "object" && o.metadata !== null ? (o.metadata as Record<string, unknown>) : undefined,
    is_claimed: o.is_claimed === true || o.is_claimed === "true",
    claimed_at: o.claimed_at != null ? String(o.claimed_at) : undefined,
    owner: typeof o.owner === "object" && o.owner !== null ? (o.owner as AgentMe["owner"]) : undefined,
    stats: typeof o.stats === "object" && o.stats !== null ? (o.stats as AgentMe["stats"]) : undefined,
  };
}

export class MoltbookClientError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "MoltbookClientError";
  }
}

function isRetryable(statusCode: number): boolean {
  return statusCode >= 500 || statusCode === 429;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MoltbookClientConfig {
  apiKey: string;
  baseUrl?: string;
  useMocks?: boolean;
  /** Optional: log raw API responses (e.g. GET /submolts) for debugging. */
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class MoltbookClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly useMocks: boolean;
  private readonly onLog?: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(config: MoltbookClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.useMocks = config.useMocks ?? false;
    this.onLog = config.onLog;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    let lastError: MoltbookClientError | null = null;
    let backoff = INITIAL_BACKOFF_MS;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { ...options, headers });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          const err = body as MoltbookApiError;
          const msg = err?.error ?? res.statusText;
          const hint = err?.hint;
          lastError = new MoltbookClientError(msg, hint, res.status);
          if (isRetryable(res.status) && attempt < MAX_RETRIES - 1) {
            await sleep(backoff);
            backoff *= 2;
            continue;
          }
          throw lastError;
        }

        if (body && typeof body === "object" && "success" in body) {
          if ((body as { success: boolean }).success === false) {
            const err = body as MoltbookApiError;
            lastError = new MoltbookClientError(err.error ?? "Unknown error", err.hint);
            throw lastError;
          }
          if (path === "/submolts" && this.onLog) {
            this.onLog("GET /submolts raw response", { body });
          }
          const b = body as unknown as { data?: T };
          if (b.data !== undefined) return b.data;
          return body as T;
        }
        return body as T;
      } catch (e) {
        if (e instanceof MoltbookClientError) throw e;
        lastError = new MoltbookClientError(
          e instanceof Error ? e.message : String(e)
        );
        if (attempt < MAX_RETRIES - 1) {
          await sleep(backoff);
          backoff *= 2;
        } else {
          throw lastError;
        }
      }
    }

    throw lastError ?? new MoltbookClientError("Request failed after retries");
  }

  /** POST with FormData (no Content-Type; for file uploads). */
  private async requestForm<T>(path: string, formData: FormData): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    const res = await fetch(url, { method: "POST", headers, body: formData });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body as MoltbookApiError;
      throw new MoltbookClientError(err?.error ?? res.statusText, err?.hint, res.status);
    }
    if (body && typeof body === "object" && "success" in body && (body as { success: boolean }).success === false) {
      const err = body as MoltbookApiError;
      throw new MoltbookClientError(err.error ?? "Unknown error", err.hint);
    }
    const b = body as unknown as { data?: T };
    if (b?.data !== undefined) return b.data as T;
    return body as T;
  }

  /** GET /submolts — list communities. Normalizes { data: [...] } or { data: { submolts: [...] } }. */
  async getSubmolts(): Promise<Submolt[]> {
    if (this.useMocks) return this.mockGetSubmolts();
    const data = await this.request<Submolt[] | { submolts?: Submolt[] }>("/submolts");
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && "submolts" in data && Array.isArray((data as { submolts: Submolt[] }).submolts)) {
      return (data as { submolts: Submolt[] }).submolts;
    }
    return [];
  }

  /** GET /posts or /submolts/:name/feed — list posts */
  async getPosts(submoltName?: string, sort: string = "new", limit = 25): Promise<Post[]> {
    if (this.useMocks) return this.mockGetPosts(submoltName);
    const path = submoltName
      ? `/submolts/${encodeURIComponent(submoltName)}/feed?sort=${sort}&limit=${limit}`
      : `/posts?sort=${sort}&limit=${limit}`;
    const data = await this.request<Post[]>(path);
    return Array.isArray(data) ? data : [];
  }

  /** GET /posts/:id — single post */
  async getPost(postId: string): Promise<Post> {
    if (this.useMocks) return this.mockGetPost(postId);
    return this.request<Post>(`/posts/${encodeURIComponent(postId)}`);
  }

  /** GET /posts/:id/comments — comments on a post. If API returns 405 Method Not Allowed, falls back to GET /posts/:id and uses embedded comments if present. */
  async getComments(postId: string, sort: string = "top"): Promise<Comment[]> {
    if (this.useMocks) return this.mockGetComments(postId);
    try {
      const data = await this.request<Comment[]>(
        `/posts/${encodeURIComponent(postId)}/comments?sort=${sort}`,
        { method: "GET" }
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      const is405 = err instanceof MoltbookClientError && err.statusCode === 405;
      if (is405) {
        const postWithComments = await this.request<Post & { comments?: Comment[] }>(
          `/posts/${encodeURIComponent(postId)}`,
          { method: "GET" }
        );
        const comments = postWithComments?.comments;
        return Array.isArray(comments) ? comments : [];
      }
      throw err;
    }
  }

  /** POST /posts — create post (submolt, title, content) */
  async postPost(submolt: string, title: string, content: string): Promise<Post> {
    if (this.useMocks) return this.mockPostPost(submolt, title, content);
    return this.request<Post>("/posts", {
      method: "POST",
      body: JSON.stringify({ submolt, title, content }),
    });
  }

  /** POST /posts/:id/comments — add comment (optional parent_id for reply) */
  async postComment(postId: string, content: string, parentId?: string): Promise<Comment> {
    if (this.useMocks) return this.mockPostComment(postId, content);
    const body = parentId ? { content, parent_id: parentId } : { content };
    return this.request<Comment>(`/posts/${encodeURIComponent(postId)}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** POST /posts/:id/upvote */
  async upvotePost(postId: string): Promise<void> {
    if (this.useMocks) return this.mockVotePost(postId, "up");
    await this.request(`/posts/${encodeURIComponent(postId)}/upvote`, { method: "POST" });
  }

  /** POST /posts/:id/downvote */
  async downvotePost(postId: string): Promise<void> {
    if (this.useMocks) return this.mockVotePost(postId, "down");
    await this.request(`/posts/${encodeURIComponent(postId)}/downvote`, { method: "POST" });
  }

  /** POST /comments/:id/upvote */
  async upvoteComment(commentId: string): Promise<void> {
    if (this.useMocks) return this.mockVoteComment(commentId, "up");
    await this.request(`/comments/${encodeURIComponent(commentId)}/upvote`, { method: "POST" });
  }

  /** POST /comments/:id/downvote (assumed; skill.md shows upvote only) */
  async downvoteComment(commentId: string): Promise<void> {
    if (this.useMocks) return this.mockVoteComment(commentId, "down");
    await this.request(`/comments/${encodeURIComponent(commentId)}/downvote`, { method: "POST" });
  }

  /** Vote on post or comment: dispatches to upvote/downvote post or comment */
  async vote(targetId: string, direction: "up" | "down", targetType: "post" | "comment"): Promise<void> {
    if (targetType === "post") {
      if (direction === "up") await this.upvotePost(targetId);
      else await this.downvotePost(targetId);
    } else {
      if (direction === "up") await this.upvoteComment(targetId);
      else await this.downvoteComment(targetId);
    }
  }

  /** GET /agents/status — pending_claim | claimed (API may return { status } or { success, data: { status } }) */
  async getAgentStatus(): Promise<AgentStatus> {
    if (this.useMocks) return "claimed";
    const data = await this.request<{ status?: AgentStatus }>("/agents/status");
    const status = data?.status;
    return status === "claimed" ? "claimed" : "pending_claim";
  }

  /** GET /agents/me — current agent profile (API returns { success, agent }) */
  async getAgentMe(): Promise<AgentMe> {
    if (this.useMocks) return { id: "mock-id", name: "mock-agent", is_claimed: true };
    const res = await this.request<AgentMe | { agent?: AgentMe }>("/agents/me");
    const raw = (res && "agent" in res && res.agent) ? res.agent : (res as AgentMe);
    return normalizeAgentMe(raw);
  }

  /** GET /agents/profile?name=MOLTY_NAME — view another molty's profile (SKILL). */
  async getAgentProfile(moltyName: string): Promise<AgentMe> {
    if (this.useMocks) return { id: "", name: moltyName, is_claimed: false };
    const res = await this.request<AgentMe | { agent?: AgentMe }>(`/agents/profile?name=${encodeURIComponent(moltyName)}`);
    const raw = (res && "agent" in res && res.agent) ? res.agent : (res as AgentMe);
    return normalizeAgentMe(raw);
  }

  /** GET /feed — personalized feed (subscribed submolts + followed moltys). Sort: hot, new, top. */
  async getFeed(sort: string = "new", limit = 25): Promise<Post[]> {
    if (this.useMocks) return this.mockGetPosts();
    const data = await this.request<Post[]>(`/feed?sort=${sort}&limit=${limit}`);
    return Array.isArray(data) ? data : [];
  }

  /** POST /posts — create link post (submolt, title, url). */
  async postLinkPost(submolt: string, title: string, url: string): Promise<Post> {
    if (this.useMocks) return this.mockPostLinkPost(submolt, title, url);
    return this.request<Post>("/posts", {
      method: "POST",
      body: JSON.stringify({ submolt, title, url }),
    });
  }

  /** DELETE /posts/:id — delete your post. */
  async deletePost(postId: string): Promise<void> {
    if (this.useMocks) return this.mockDeletePost(postId);
    await this.request(`/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
  }

  /** POST /submolts/:name/subscribe — subscribe to a submolt. */
  async subscribeSubmolt(name: string): Promise<void> {
    if (this.useMocks) return this.mockSubscribeSubmolt(name);
    await this.request(`/submolts/${encodeURIComponent(name)}/subscribe`, { method: "POST" });
  }

  /** DELETE /submolts/:name/subscribe — unsubscribe. */
  async unsubscribeSubmolt(name: string): Promise<void> {
    if (this.useMocks) return this.mockUnsubscribeSubmolt(name);
    await this.request(`/submolts/${encodeURIComponent(name)}/subscribe`, { method: "DELETE" });
  }

  /** POST /agents/:name/follow — follow a molty. */
  async followAgent(moltyName: string): Promise<void> {
    if (this.useMocks) return this.mockFollowAgent(moltyName);
    await this.request(`/agents/${encodeURIComponent(moltyName)}/follow`, { method: "POST" });
  }

  /** DELETE /agents/:name/follow — unfollow. */
  async unfollowAgent(moltyName: string): Promise<void> {
    if (this.useMocks) return this.mockUnfollowAgent(moltyName);
    await this.request(`/agents/${encodeURIComponent(moltyName)}/follow`, { method: "DELETE" });
  }

  /** GET /search — semantic search. type: posts | comments | all (default). */
  async search(query: string, type: "posts" | "comments" | "all" = "all", limit = 20): Promise<SearchResult[]> {
    if (this.useMocks) return this.mockSearch(query);
    const q = encodeURIComponent(query.slice(0, 500));
    const data = await this.request<SearchResult[] | { results?: SearchResult[] }>(
      `/search?q=${q}&type=${type}&limit=${limit}`
    );
    const list = Array.isArray(data) ? data : (data && "results" in data ? data.results : []);
    return Array.isArray(list) ? list : [];
  }

  /** GET /submolts/:name — get single submolt info. */
  async getSubmolt(name: string): Promise<Submolt> {
    if (this.useMocks) return { name, display_name: name };
    return this.request<Submolt>(`/submolts/${encodeURIComponent(name)}`);
  }

  /** PATCH /agents/me — update profile (description and/or metadata). */
  async updateProfile(updates: { description?: string; metadata?: Record<string, unknown> }): Promise<AgentMe> {
    if (this.useMocks) return { id: "mock-id", name: "mock-agent", is_claimed: true };
    const res = await this.request<AgentMe | { agent?: AgentMe }>("/agents/me", {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    return (res && "agent" in res && res.agent) ? res.agent : (res as AgentMe);
  }

  /** POST /submolts — create a submolt. */
  async createSubmolt(name: string, display_name: string, description: string): Promise<Submolt> {
    if (this.useMocks) return { name, display_name, description };
    return this.request<Submolt>("/submolts", {
      method: "POST",
      body: JSON.stringify({ name, display_name, description }),
    });
  }

  // ─── DMs (MESSAGING.md) ─────────────────────────────────────────────────

  /** GET /agents/dm/check — quick poll for DM activity (heartbeat). */
  async dmCheck(): Promise<DmCheckResponse> {
    if (this.useMocks) return { has_activity: false };
    const res = await this.request<DmCheckResponse>("/agents/dm/check");
    return (res && typeof res === "object") ? res : {};
  }

  /** POST /agents/dm/request — send a chat request (to: bot name, or to_owner: @handle). */
  async dmRequest(params: { to?: string; to_owner?: string; message: string }): Promise<unknown> {
    if (this.useMocks) return {};
    return this.request("/agents/dm/request", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /** GET /agents/dm/requests — list pending requests. */
  async dmListRequests(): Promise<{ items?: DmRequestItem[] }> {
    if (this.useMocks) return {};
    const res = await this.request<{ requests?: { items?: DmRequestItem[] } }>("/agents/dm/requests");
    const items = res && "requests" in res ? (res as { requests?: { items?: DmRequestItem[] } }).requests?.items : undefined;
    return { items };
  }

  /** POST /agents/dm/requests/:id/approve — approve a chat request. */
  async dmApproveRequest(conversationId: string): Promise<void> {
    if (this.useMocks) return;
    await this.request(`/agents/dm/requests/${encodeURIComponent(conversationId)}/approve`, { method: "POST" });
  }

  /** POST /agents/dm/requests/:id/reject — reject (optionally block). */
  async dmRejectRequest(conversationId: string, block?: boolean): Promise<void> {
    if (this.useMocks) return;
    const body = block ? JSON.stringify({ block: true }) : undefined;
    await this.request(`/agents/dm/requests/${encodeURIComponent(conversationId)}/reject`, {
      method: "POST",
      ...(body && { body, headers: { "Content-Type": "application/json" } }),
    });
  }

  /** GET /agents/dm/conversations — list active conversations. */
  async dmListConversations(): Promise<DmConversationsResponse> {
    if (this.useMocks) return {};
    const res = await this.request<DmConversationsResponse | { conversations?: DmConversationsResponse["conversations"] }>("/agents/dm/conversations");
    if (res && "conversations" in res) return res as DmConversationsResponse;
    return (res as DmConversationsResponse) ?? {};
  }

  /** GET /agents/dm/conversations/:id — read conversation (marks as read). */
  async dmGetConversation(conversationId: string): Promise<DmConversationResponse> {
    if (this.useMocks) return {};
    const res = await this.request<DmConversationResponse>(`/agents/dm/conversations/${encodeURIComponent(conversationId)}`);
    return (res && typeof res === "object") ? res : {};
  }

  /** POST /agents/dm/conversations/:id/send — send a message (optional needs_human_input). */
  async dmSendMessage(conversationId: string, message: string, needsHumanInput?: boolean): Promise<unknown> {
    if (this.useMocks) return {};
    const body = needsHumanInput ? { message, needs_human_input: true } : { message };
    return this.request(`/agents/dm/conversations/${encodeURIComponent(conversationId)}/send`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // ─── Avatar (SKILL.md "Upload your avatar" — /agents/me/avatar, file only) ─────

  /** POST /agents/me/avatar — your profile avatar. File only (no type). Max 500 KB, jpeg/png/gif/webp. */
  async uploadAvatar(filePath: string): Promise<AgentMe> {
    if (this.useMocks) return { id: "mock-id", name: "mock-agent", is_claimed: true };
    const buf = await readFile(filePath);
    const mime = avatarMimeFromPath(filePath);
    const blob = new Blob([buf], { type: mime });
    const form = new FormData();
    form.append("file", blob, basename(filePath));
    const res = await this.requestForm<AgentMe | { agent?: AgentMe; data?: { agent?: AgentMe } }>("/agents/me/avatar", form);
    const raw = (res && "agent" in res && res.agent) ? res.agent : (res && "data" in res && res.data?.agent) ? res.data.agent : (res as AgentMe);
    return normalizeAgentMe(raw);
  }

  /** DELETE /agents/me/avatar — remove avatar. */
  async deleteAvatar(): Promise<void> {
    if (this.useMocks) return;
    await this.request("/agents/me/avatar", { method: "DELETE" });
  }

  // ─── Submolt mod (pin, settings, moderators) ─────────────────────────────

  /** POST /posts/:id/pin — pin a post (max 3 per submolt). */
  async pinPost(postId: string): Promise<void> {
    if (this.useMocks) return;
    await this.request(`/posts/${encodeURIComponent(postId)}/pin`, { method: "POST" });
  }

  /** DELETE /posts/:id/pin — unpin. */
  async unpinPost(postId: string): Promise<void> {
    if (this.useMocks) return;
    await this.request(`/posts/${encodeURIComponent(postId)}/pin`, { method: "DELETE" });
  }

  /** PATCH /submolts/:name/settings — update description, banner_color, theme_color. */
  async updateSubmoltSettings(
    submoltName: string,
    updates: { description?: string; banner_color?: string; theme_color?: string }
  ): Promise<Submolt> {
    if (this.useMocks) return { name: submoltName };
    return this.request<Submolt>(`/submolts/${encodeURIComponent(submoltName)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  /** POST /submolts/:name/settings — upload submolt avatar or banner (SKILL.md "Upload submolt avatar/banner": file + type=avatar|banner). */
  async uploadSubmoltAsset(submoltName: string, filePath: string, type: "avatar" | "banner"): Promise<Submolt> {
    if (this.useMocks) return { name: submoltName };
    const buf = await readFile(filePath);
    const mime = avatarMimeFromPath(filePath);
    const blob = new Blob([buf], { type: mime });
    const form = new FormData();
    form.append("file", blob, basename(filePath));
    form.append("type", type);
    const res = await this.requestForm<Submolt>(`/submolts/${encodeURIComponent(submoltName)}/settings`, form);
    return (res && typeof res === "object") ? res : { name: submoltName };
  }

  /** POST /submolts/:name/moderators — add moderator (owner only). */
  async addSubmoltModerator(submoltName: string, agentName: string, role = "moderator"): Promise<void> {
    if (this.useMocks) return;
    await this.request(`/submolts/${encodeURIComponent(submoltName)}/moderators`, {
      method: "POST",
      body: JSON.stringify({ agent_name: agentName, role }),
    });
  }

  /** DELETE /submolts/:name/moderators — remove moderator (owner only). */
  async removeSubmoltModerator(submoltName: string, agentName: string): Promise<void> {
    if (this.useMocks) return;
    await this.request(`/submolts/${encodeURIComponent(submoltName)}/moderators`, {
      method: "DELETE",
      body: JSON.stringify({ agent_name: agentName }),
    });
  }

  /** GET /submolts/:name/moderators — list moderators. */
  async listSubmoltModerators(submoltName: string): Promise<SubmoltModerator[]> {
    if (this.useMocks) return [];
    const data = await this.request<SubmoltModerator[] | { moderators?: SubmoltModerator[] }>(
      `/submolts/${encodeURIComponent(submoltName)}/moderators`
    );
    const list = Array.isArray(data) ? data : (data && "moderators" in data ? data.moderators : []);
    return Array.isArray(list) ? list : [];
  }

  /** POST /agents/register — one-time; returns api_key and claim_url. Call once, save api_key to env. */
  async register(name: string, description: string): Promise<RegisterResponse> {
    if (this.useMocks) {
      return {
        success: true,
        message: "Welcome to Moltbook! 🦞",
        agent: {
          id: "mock-id-" + Date.now(),
          name,
          api_key: "moltbook_mock_" + Date.now(),
          claim_url: "https://www.moltbook.com/claim/mock",
          verification_code: "mock-123",
        },
      };
    }
    const res = await fetch(`${this.baseUrl}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    const body = await res.json();
    if (!res.ok) {
      const err = body as MoltbookApiError;
      throw new MoltbookClientError(err?.error ?? res.statusText, err?.hint, res.status);
    }
    return body as RegisterResponse;
  }

  // ─── Mocks for local testing ─────────────────────────────────────────────

  private mockGetSubmolts(): Promise<Submolt[]> {
    return Promise.resolve([
      { name: "general", display_name: "General" },
      { name: "tech", display_name: "Tech" },
    ]);
  }

  private mockGetPosts(submoltName?: string): Promise<Post[]> {
    const submolt = submoltName ?? "general";
    return Promise.resolve([
      {
        id: `p-${submolt}-1`,
        submolt,
        author: { name: "u1" },
        title: "Sample post",
        content: "Sample content",
        created_at: new Date().toISOString(),
        score: 5,
      },
    ]);
  }

  private mockGetPost(postId: string): Promise<Post> {
    return Promise.resolve({
      id: postId,
      submolt: "general",
      author: { name: "u1" },
      title: "Sample post",
      content: "Sample content",
      created_at: new Date().toISOString(),
      score: 5,
    });
  }

  private mockGetComments(postId: string): Promise<Comment[]> {
    return Promise.resolve([
      {
        id: `c-${postId}-1`,
        post_id: postId,
        author: { name: "u2" },
        content: "Sample comment",
        created_at: new Date().toISOString(),
        score: 2,
      },
    ]);
  }

  private mockPostPost(submolt: string, title: string, content: string): Promise<Post> {
    return Promise.resolve({
      id: `p-mock-${Date.now()}`,
      submolt,
      author: { name: "agent" },
      title,
      content,
      created_at: new Date().toISOString(),
    });
  }

  private mockPostLinkPost(submolt: string, title: string, url: string): Promise<Post> {
    return Promise.resolve({
      id: `p-mock-${Date.now()}`,
      submolt,
      author: { name: "agent" },
      title,
      url,
      created_at: new Date().toISOString(),
    });
  }

  private mockDeletePost(postId: string): Promise<void> {
    void postId;
    return Promise.resolve();
  }

  private mockSubscribeSubmolt(name: string): Promise<void> {
    void name;
    return Promise.resolve();
  }

  private mockUnsubscribeSubmolt(name: string): Promise<void> {
    void name;
    return Promise.resolve();
  }

  private mockFollowAgent(moltyName: string): Promise<void> {
    void moltyName;
    return Promise.resolve();
  }

  private mockUnfollowAgent(moltyName: string): Promise<void> {
    void moltyName;
    return Promise.resolve();
  }

  private mockSearch(query: string): Promise<SearchResult[]> {
    void query;
    return Promise.resolve([]);
  }

  private mockPostComment(postId: string, content: string): Promise<Comment> {
    return Promise.resolve({
      id: `c-mock-${Date.now()}`,
      post_id: postId,
      author: { name: "agent" },
      content,
      created_at: new Date().toISOString(),
    });
  }

  private mockVotePost(postId: string, direction: "up" | "down"): Promise<void> {
    void postId;
    void direction;
    return Promise.resolve();
  }

  private mockVoteComment(commentId: string, direction: "up" | "down"): Promise<void> {
    void commentId;
    void direction;
    return Promise.resolve();
  }
}
