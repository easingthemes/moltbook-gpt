import type { Decision } from "../types/decision.js";

export interface PolicyConfig {
  maxPostsPerHour: number;
  maxCommentsPerThread: number;
  confidenceThreshold: number;
  maxContentLength: number;
  cooldownMinutesPerSubmolt: number;
}

const DEFAULT_CONFIG: PolicyConfig = {
  maxPostsPerHour: 5,
  maxCommentsPerThread: 3,
  confidenceThreshold: 0.6,
  maxContentLength: 2000,
  cooldownMinutesPerSubmolt: 10,
};

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export class PolicyEngine {
  private readonly config: PolicyConfig;
  private postsInLastHour: number[] = [];
  private commentsByThread: Map<string, number> = new Map();
  private lastPostBySubmolt: Map<string, number> = new Map();
  private recentContentHashes: string[] = [];
  private readonly maxRecentHashes = 50;

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Final veto before execution. Returns allowed or reason. */
  validate(decision: Decision, context: {
    submoltId?: string;
    threadId?: string;
    actionSource: "post" | "comment" | "vote" | "ignore";
  }): PolicyVerdict {
    if (decision.action === "ignore") {
      return { allowed: true };
    }

    if (decision.confidence < this.config.confidenceThreshold) {
      return { allowed: false, reason: "confidence below threshold" };
    }

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    this.postsInLastHour = this.postsInLastHour.filter((t) => t > oneHourAgo);

    if (decision.action === "post") {
      if (this.postsInLastHour.length >= this.config.maxPostsPerHour) {
        return { allowed: false, reason: "max posts per hour exceeded" };
      }
      if (decision.content) {
        if (decision.content.length > this.config.maxContentLength) {
          return { allowed: false, reason: "content too long" };
        }
        if (this.isRepetition(decision.content)) {
          return { allowed: false, reason: "repetition detected" };
        }
      }
      if (context.submoltId) {
        const last = this.lastPostBySubmolt.get(context.submoltId);
        const cooldownMs = this.config.cooldownMinutesPerSubmolt * 60 * 1000;
        if (last != null && now - last < cooldownMs) {
          return { allowed: false, reason: "submolt cooldown" };
        }
      }
    }

    if (decision.action === "comment") {
      const threadId = context.threadId ?? decision.targetId;
      if (threadId) {
        const count = this.commentsByThread.get(threadId) ?? 0;
        if (count >= this.config.maxCommentsPerThread) {
          return { allowed: false, reason: "max comments per thread exceeded" };
        }
      }
      if (decision.content) {
        if (decision.content.length > this.config.maxContentLength) {
          return { allowed: false, reason: "content too long" };
        }
        if (this.isRepetition(decision.content)) {
          return { allowed: false, reason: "repetition detected" };
        }
      }
    }

    if (decision.action === "vote") {
      if (!decision.targetId || !decision.voteDirection) {
        return { allowed: false, reason: "vote requires targetId and voteDirection" };
      }
    }

    return { allowed: true };
  }

  /** Call after executing an action to update internal state. */
  recordAction(action: "post" | "comment", context: {
    submoltId?: string;
    threadId?: string;
    content?: string;
  }): void {
    const now = Date.now();
    if (action === "post") {
      this.postsInLastHour.push(now);
      if (context.submoltId) {
        this.lastPostBySubmolt.set(context.submoltId, now);
      }
      if (context.content) this.addContentHash(context.content);
    }
    if (action === "comment") {
      if (context.threadId) {
        const count = this.commentsByThread.get(context.threadId) ?? 0;
        this.commentsByThread.set(context.threadId, count + 1);
      }
      if (context.content) this.addContentHash(context.content);
    }
  }

  private simpleHash(s: string): string {
    let h = 0;
    const normalized = s.toLowerCase().replace(/\s+/g, " ").trim();
    for (let i = 0; i < normalized.length; i++) {
      h = (h * 31 + normalized.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  private addContentHash(content: string): void {
    const hash = this.simpleHash(content);
    this.recentContentHashes.push(hash);
    if (this.recentContentHashes.length > this.maxRecentHashes) {
      this.recentContentHashes.shift();
    }
  }

  private isRepetition(content: string): boolean {
    const hash = this.simpleHash(content);
    return this.recentContentHashes.includes(hash);
  }
}
