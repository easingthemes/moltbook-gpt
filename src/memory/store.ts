import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import type { Decision } from "../types/decision.js";

export interface StoredDecision {
  at: string;
  context: { submoltId?: string; threadId?: string };
  decision: Decision;
  outcome?: "executed" | "blocked" | "skipped";
}

export interface MemoryState {
  lastSeenThreadIds: string[];
  lastSeenCommentIds: string[];
  agentPostIds: string[];
  agentCommentIds: string[];
  recentDecisions: StoredDecision[];
  agentId?: string;
  claimedAt?: string;
  /** Set after attempting the initial post (success or fail) so we never retry. */
  firstPostAttempted?: boolean;
  /** Normalized hashes of (title + content) of recent agent posts for duplicate check. */
  recentPostContentHashes: string[];
  /** ISO timestamp of last completed tick; used to schedule next tick. */
  lastTickAt?: string;
  /** Summary of what the last tick did (for logging "last tick / next tick"). */
  lastTickSummary?: LastTickSummary;
  /** ISO timestamp of last post to Moltbook; used to enforce POST_INTERVAL_MINUTES. */
  lastPostAt?: string;
}

export interface LastTickSummary {
  at: string;
  source: "feed" | "submolts" | "global";
  feedOrSubmoltCount: number;
  newPostsProcessed: number;
  dmActivity?: boolean;
  dmPendingRequests?: number;
  dmUnread?: number;
}

const MAX_LAST_SEEN = 500;
const MAX_AGENT_IDS = 200;
const MAX_RECENT_DECISIONS = 100;
const MAX_RECENT_POST_HASHES = 100;

export interface MemoryStoreConfig {
  filePath?: string;
}

const defaultPath = (): string => {
  return process.env.MEMORY_FILE ?? join(process.cwd(), "data", "memory.json");
};

export class MemoryStore {
  private state: MemoryState = {
    lastSeenThreadIds: [],
    lastSeenCommentIds: [],
    agentPostIds: [],
    agentCommentIds: [],
    recentDecisions: [],
    recentPostContentHashes: [],
  };
  private readonly filePath: string;
  private dirty = false;

  constructor(config: MemoryStoreConfig = {}) {
    this.filePath = config.filePath ?? defaultPath();
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Partial<MemoryState>;
      this.state = {
        lastSeenThreadIds: data.lastSeenThreadIds ?? [],
        lastSeenCommentIds: data.lastSeenCommentIds ?? [],
        agentPostIds: data.agentPostIds ?? [],
        agentCommentIds: data.agentCommentIds ?? [],
        recentDecisions: data.recentDecisions ?? [],
        agentId: data.agentId,
        claimedAt: data.claimedAt,
        firstPostAttempted: data.firstPostAttempted ?? false,
        recentPostContentHashes: data.recentPostContentHashes ?? [],
        lastTickAt: data.lastTickAt,
        lastTickSummary: data.lastTickSummary,
        lastPostAt: data.lastPostAt,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify(this.state, null, 2),
      "utf-8"
    );
    this.dirty = false;
  }

  /** Context for LLM: recent agent memory (decisions + own posts). */
  getContext(): {
    recentDecisions: StoredDecision[];
    agentPostIds: string[];
    agentCommentIds: string[];
    recentAgentMemory: string[];
  } {
    const recent = this.state.recentDecisions.slice(-20);
    const memoryLines = recent.map((d) => {
      const ctx = d.context.threadId ? `thread=${d.context.threadId}` : `submolt=${d.context.submoltId ?? "?"}`;
      return `[${d.at}] ${d.decision.action} ${ctx} conf=${d.decision.confidence} ${d.outcome ?? "-"}`;
    });
    return {
      recentDecisions: recent,
      agentPostIds: [...this.state.agentPostIds],
      agentCommentIds: [...this.state.agentCommentIds],
      recentAgentMemory: memoryLines,
    };
  }

  saveDecision(
    context: { submoltId?: string; threadId?: string },
    decision: Decision,
    outcome?: "executed" | "blocked" | "skipped"
  ): void {
    this.state.recentDecisions.push({
      at: new Date().toISOString(),
      context,
      decision,
      outcome,
    });
    if (this.state.recentDecisions.length > MAX_RECENT_DECISIONS) {
      this.state.recentDecisions = this.state.recentDecisions.slice(-MAX_RECENT_DECISIONS);
    }
    this.dirty = true;
  }

  markThreadSeen(threadId: string): void {
    if (!this.state.lastSeenThreadIds.includes(threadId)) {
      this.state.lastSeenThreadIds.push(threadId);
      if (this.state.lastSeenThreadIds.length > MAX_LAST_SEEN) {
        this.state.lastSeenThreadIds = this.state.lastSeenThreadIds.slice(-MAX_LAST_SEEN);
      }
      this.dirty = true;
    }
  }

  markCommentSeen(commentId: string): void {
    if (!this.state.lastSeenCommentIds.includes(commentId)) {
      this.state.lastSeenCommentIds.push(commentId);
      if (this.state.lastSeenCommentIds.length > MAX_LAST_SEEN) {
        this.state.lastSeenCommentIds = this.state.lastSeenCommentIds.slice(-MAX_LAST_SEEN);
      }
      this.dirty = true;
    }
  }

  isThreadSeen(threadId: string): boolean {
    return this.state.lastSeenThreadIds.includes(threadId);
  }

  isCommentSeen(commentId: string): boolean {
    return this.state.lastSeenCommentIds.includes(commentId);
  }

  addAgentPostId(id: string): void {
    this.state.agentPostIds.push(id);
    if (this.state.agentPostIds.length > MAX_AGENT_IDS) {
      this.state.agentPostIds = this.state.agentPostIds.slice(-MAX_AGENT_IDS);
    }
    this.dirty = true;
  }

  addAgentCommentId(id: string): void {
    this.state.agentCommentIds.push(id);
    if (this.state.agentCommentIds.length > MAX_AGENT_IDS) {
      this.state.agentCommentIds = this.state.agentCommentIds.slice(-MAX_AGENT_IDS);
    }
    this.dirty = true;
  }

  setAgentId(agentId: string): void {
    this.state.agentId = agentId;
    this.state.claimedAt = new Date().toISOString();
    this.dirty = true;
  }

  getAgentId(): string | undefined {
    return this.state.agentId;
  }

  isClaimed(): boolean {
    return Boolean(this.state.agentId);
  }

  /** True after we've attempted the initial post once (success or fail). */
  hasAttemptedFirstPost(): boolean {
    return Boolean(this.state.firstPostAttempted);
  }

  setFirstPostAttempted(): void {
    this.state.firstPostAttempted = true;
    this.dirty = true;
  }

  private static contentHash(title: string, content: string): string {
    const t = (title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const c = (content ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    let h = 0;
    const s = t + "\n" + c;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  /** Record post content so we can detect duplicates later. */
  addAgentPostContent(title: string, content: string): void {
    const hash = MemoryStore.contentHash(title, content);
    this.state.recentPostContentHashes.push(hash);
    if (this.state.recentPostContentHashes.length > MAX_RECENT_POST_HASHES) {
      this.state.recentPostContentHashes = this.state.recentPostContentHashes.slice(-MAX_RECENT_POST_HASHES);
    }
    this.dirty = true;
  }

  /** True if this title+content matches a previous agent post (normalized). */
  isDuplicatePost(title: string, content: string): boolean {
    const hash = MemoryStore.contentHash(title, content);
    return this.state.recentPostContentHashes.includes(hash);
  }

  /** ISO timestamp of last completed tick; undefined if never run. */
  getLastTickAt(): string | undefined {
    return this.state.lastTickAt;
  }

  /** Call at end of each tick so next tick is scheduled from last run. */
  setLastTickAt(isoTimestamp: string): void {
    this.state.lastTickAt = isoTimestamp;
    this.dirty = true;
  }

  /** Summary of last completed tick (for logging). */
  getLastTickSummary(): LastTickSummary | undefined {
    return this.state.lastTickSummary;
  }

  /** Call at end of each tick with what this tick did. */
  setLastTickSummary(summary: LastTickSummary): void {
    this.state.lastTickSummary = summary;
    this.dirty = true;
  }

  /** ISO timestamp of last post to Moltbook; undefined if never posted. */
  getLastPostAt(): string | undefined {
    return this.state.lastPostAt;
  }

  /** Call after successfully posting to Moltbook (enforces POST_INTERVAL_MINUTES). */
  setLastPostAt(isoTimestamp: string): void {
    this.state.lastPostAt = isoTimestamp;
    this.dirty = true;
  }
}
