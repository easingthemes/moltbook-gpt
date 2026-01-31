import type { MoltbookClient } from "../moltbook/client.js";
import type { ChatGPTClient } from "../llm/chatgpt-client.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { MemoryStore, LastTickSummary } from "../memory/store.js";
import type { DecisionContext } from "../types/decision.js";
import type { Submolt, Post, Comment } from "../types/moltbook.js";
import type { SearchResult } from "../types/moltbook.js";

export interface SchedulerConfig {
  /** How often we run a tick (feed check, AI decision). */
  tickIntervalMinutes: number;
  /** Min minutes between posts to Moltbook (rate limit). */
  postIntervalMinutes: number;
  dryRun: boolean;
  /** If true, use GET /feed (personalized) instead of per-submolt feeds. */
  usePersonalizedFeed?: boolean;
}

export interface SchedulerDeps {
  moltbook: MoltbookClient;
  llm: ChatGPTClient;
  policy: PolicyEngine;
  memory: MemoryStore;
  config: SchedulerConfig;
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.intervalId != null) return;
    this.running = true;
    const tickIntervalMs = this.deps.config.tickIntervalMinutes * 60 * 1000;
    const tick = () =>
      this.tick().catch((err) => {
        this.log("tick error", { error: String(err) });
        const nextAt = new Date(Date.now() + tickIntervalMs).toISOString();
        this.log("paused: tick error", { error: String(err) });
        this.log("next action: next tick", { at: nextAt, inMinutes: this.deps.config.tickIntervalMinutes });
        this.log("next Moltbook activity (feed check, AI decision, possible post/comment/vote)", { at: nextAt, inMinutes: this.deps.config.tickIntervalMinutes });
      });

    const lastTickAt = this.deps.memory.getLastTickAt();
    const lastTickSummary = this.deps.memory.getLastTickSummary();
    const nextTickAtIso = new Date(Date.now() + tickIntervalMs).toISOString();
    this.log("last tick / next tick", {
      lastTickAt: lastTickAt ?? "(none)",
      lastTickSummary: lastTickSummary ?? "(no summary; load memory or run a tick)",
      nextTickAt: nextTickAtIso,
      firstTickOnStart: "always run all GET checks (DM, feed/submolts) on start",
    });
    this.log("scheduler started: first tick now (all GET checks run on start regardless of last tick)", {
      tickIntervalMinutes: this.deps.config.tickIntervalMinutes,
      postIntervalMinutes: this.deps.config.postIntervalMinutes,
    });
    this.log("next Moltbook activity (feed check, AI decision, possible post/comment/vote)", { at: "now", inMinutes: 0 });
    tick();
    this.intervalId = setInterval(tick, tickIntervalMs);
  }

  stop(): void {
    if (this.timeoutId != null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    this.log("scheduler stopped");
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    this.deps.onLog?.(msg, meta);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const { moltbook, memory } = this.deps;
    const tickIntervalMinutes = this.deps.config.tickIntervalMinutes;
    const postIntervalMinutes = this.deps.config.postIntervalMinutes;
    const tickIntervalMs = tickIntervalMinutes * 60 * 1000;

    this.log("tick start");
    this.log("loading memory...");
    try {
      await memory.load();
      this.log("memory loaded");
    } catch (err) {
      this.log("memory load failed", { error: String(err) });
      const nextAt = new Date(Date.now() + tickIntervalMs).toISOString();
      this.log("paused: tick aborted (memory load failed)", { error: String(err) });
      this.log("next action: next tick", { at: nextAt, inMinutes: tickIntervalMinutes });
      this.log("next Moltbook activity (feed check, AI decision, possible post/comment/vote)", { at: nextAt, inMinutes: tickIntervalMinutes });
      return;
    }

    if (!memory.isClaimed()) {
      const nextAt = new Date(Date.now() + tickIntervalMs).toISOString();
      this.log("paused: agent not claimed, skipping tick");
      this.log("next action: next tick", { at: nextAt, inMinutes: tickIntervalMinutes });
      this.log("next Moltbook activity (feed check, AI decision, possible post/comment/vote)", { at: nextAt, inMinutes: tickIntervalMinutes });
      return;
    }

    let dmActivity = false;
    let dmPendingRequests: number | undefined;
    let dmUnread: number | undefined;
    this.log("checking DMs...");
    try {
      const dmCheck = await moltbook.dmCheck();
      if (dmCheck.has_activity) {
        const pending = await moltbook.dmListRequests();
        const convos = await moltbook.dmListConversations();
        const requestCount = pending.items?.length ?? 0;
        const totalUnread = convos.total_unread ?? 0;
        const convoCount = convos.conversations?.items?.length ?? 0;
        dmActivity = true;
        dmPendingRequests = requestCount;
        dmUnread = totalUnread;
        this.log("DM activity", {
          summary: dmCheck.summary,
          pending_requests: requestCount,
          conversations: convoCount,
          total_unread: totalUnread,
        });
      } else {
        this.log("DMs checked", { has_activity: false });
      }
    } catch (err) {
      this.log("dmCheck failed", { error: String(err) });
    }

    const usePersonalizedFeed = this.deps.config.usePersonalizedFeed ?? false;
    let posts: Post[] = [];
    let submolts: Submolt[] = [];

    if (usePersonalizedFeed) {
      this.log("fetching personalized feed...");
      try {
        posts = await moltbook.getFeed("new", 25);
        this.log("feed fetched", { posts: posts.length });
      } catch (err) {
        this.log("getFeed failed", { error: String(err) });
        const nextAt = new Date(Date.now() + tickIntervalMs).toISOString();
        this.log("paused: tick aborted (getFeed failed)", { error: String(err) });
        this.log("next action: next tick", { at: nextAt, inMinutes: tickIntervalMinutes });
        this.log("next Moltbook activity (feed check, AI decision, possible post/comment/vote)", { at: nextAt, inMinutes: tickIntervalMinutes });
        return;
      }
    } else {
      this.log("fetching submolts...");
      try {
        submolts = await moltbook.getSubmolts();
        this.log("submolts fetched", { count: submolts.length, names: submolts.map((s) => s.name) });
        if (submolts.length === 0) {
          this.log("no submolts from API; subscribing to general and using global posts so agent can stay active");
          try {
            await moltbook.subscribeSubmolt("general");
            this.log("subscribed to general");
          } catch (subErr) {
            this.log("subscribe to general failed (will still try global posts)", { error: String(subErr) });
          }
          try {
            posts = await moltbook.getPosts(undefined, "new", 25);
            this.log("global posts fetched", { posts: posts.length });
          } catch (postErr) {
            this.log("getPosts (global) failed", { error: String(postErr) });
          }
        }
      } catch (err) {
        this.log("getSubmolts failed", { error: String(err) });
        const nextAt = new Date(Date.now() + tickIntervalMs).toISOString();
        this.log("paused: tick aborted (getSubmolts failed)", { error: String(err) });
        this.log("next action: next tick", { at: nextAt, inMinutes: tickIntervalMinutes });
        this.log("next Moltbook activity (feed check, AI decision, possible post/comment/vote)", { at: nextAt, inMinutes: tickIntervalMinutes });
        return;
      }
    }

    let totalNew = 0;

    const processPost = async (post: Post, submoltName: string) => {
      if (memory.isThreadSeen(post.id)) return;
      totalNew++;
      this.log("processing post", { postId: post.id, submolt: submoltName, title: post.title?.slice(0, 50) });
      const ctx = this.buildContextForPost(submoltName, post, [], memory);
      const decision = await this.decideAndExecute(ctx, post.id, submoltName, undefined);
      if (decision) {
        this.log("decision outcome", { postId: post.id, action: decision.decision.action, outcome: decision.outcome });
        memory.saveDecision(
          { submoltId: submoltName, threadId: post.id },
          decision.decision,
          decision.outcome
        );
      }
      memory.markThreadSeen(post.id);

      this.log("fetching comments", { postId: post.id });
      let comments: Comment[];
      try {
        comments = await moltbook.getComments(post.id);
        this.log("comments fetched", { postId: post.id, count: comments.length });
      } catch (err) {
        this.log("getComments failed", { postId: post.id, error: String(err) });
        return;
      }

      for (const comment of comments) {
        if (memory.isCommentSeen(comment.id)) continue;
        this.log("processing comment", { commentId: comment.id, postId: post.id });
        const commentCtx = this.buildContextForPost(submoltName, post, comments, memory);
        const commentDecision = await this.decideAndExecute(
          commentCtx,
          post.id,
          submoltName,
          comment.id
        );
        if (commentDecision) {
          this.log("comment decision outcome", { commentId: comment.id, action: commentDecision.decision.action, outcome: commentDecision.outcome });
          memory.saveDecision(
            { submoltId: submoltName, threadId: post.id },
            commentDecision.decision,
            commentDecision.outcome
          );
        }
        memory.markCommentSeen(comment.id);
      }
    };

    if (usePersonalizedFeed || posts.length > 0) {
      this.log("processing feed/global posts", { total: posts.length });
      for (const post of posts) {
        const submoltName = (typeof post.submolt === "string" ? post.submolt : (post as { submolt?: { name?: string } }).submolt?.name) ?? "general";
        await processPost(post, submoltName);
      }
    } else if (submolts.length > 0) {
      let submoltsToFetch = submolts;
      try {
        const toFetch = await this.deps.llm.chooseSubmoltFeedsToFetch(submolts);
        if (toFetch.length > 0) {
          const set = new Set(toFetch);
          submoltsToFetch = submolts.filter((s) => set.has(s.name));
          this.log("fetching selected submolt feeds only", { requested: toFetch.length, selected: submoltsToFetch.map((s) => s.name) });
        } else {
          this.log("AI returned no feeds to fetch; using all submolts", { count: submolts.length });
        }
      } catch (err) {
        this.log("chooseSubmoltFeedsToFetch failed; using all submolts", { error: String(err) });
      }
      for (const submolt of submoltsToFetch) {
        this.log("fetching submolt feed", { submolt: submolt.name });
        let submoltPosts: Post[];
        try {
          submoltPosts = await moltbook.getPosts(submolt.name, "new", 25);
          this.log("submolt feed fetched", { submolt: submolt.name, posts: submoltPosts.length });
        } catch (err) {
          this.log("getPosts failed", { submolt: submolt.name, error: String(err) });
          continue;
        }
        const newInSubmolt = submoltPosts.filter((p) => !memory.isThreadSeen(p.id)).length;
        this.log("processing submolt posts", { submolt: submolt.name, total: submoltPosts.length, new: newInSubmolt });
        for (const post of submoltPosts) {
          await processPost(post, submolt.name);
        }
        if (newInSubmolt === 0) {
          this.log("no new posts in this submolt; asking AI whether to post", { submolt: submolt.name });
          await this.askProactivePostAndExecute(submolt);
        }
      }
    }

    if (totalNew === 0) {
      this.log("no new posts to process this tick");
      this.log("AI not asked for action (post/comment/vote/ignore): decisions are made only when there is at least one new unseen post or comment in the feed; none this tick", {
        whenAiDecides: "per new post: decideAction(post) → [AI INPUT]/[AI OUTPUT]; per new comment: decideAction(comment) → [AI INPUT]/[AI OUTPUT]",
      });
      const explore = await this.askExploreAndExecute(processPost);
      if (explore === "refresh") this.log("submolt list refreshed per AI decision (explore phase: feed had no new posts this tick)");
      if (explore === "search") this.log("explore search completed (triggered because feed had no new posts this tick)");
    }

    const nowIso = new Date().toISOString();
    memory.setLastTickAt(nowIso);
    const effectiveSource: LastTickSummary["source"] = usePersonalizedFeed ? "feed" : (posts.length > 0 ? "global" : "submolts");
    const effectiveCount = usePersonalizedFeed ? posts.length : (posts.length > 0 ? posts.length : submolts.length);
    const lastTickSummary: LastTickSummary = {
      at: nowIso,
      source: effectiveSource,
      feedOrSubmoltCount: effectiveCount,
      newPostsProcessed: totalNew,
      ...(dmActivity && { dmActivity: true, dmPendingRequests, dmUnread }),
    };
    memory.setLastTickSummary(lastTickSummary);
    try {
      await memory.save();
    } catch (err) {
      this.log("memory save failed", { error: String(err) });
    }
    const nextTickAtIso = new Date(Date.now() + tickIntervalMs).toISOString();
    this.log("last tick / next tick", {
      lastTickAt: nowIso,
      lastTickSummary,
      nextTickAt: nextTickAtIso,
      nextTickInMinutes: tickIntervalMinutes,
    });
    this.log("tick done", {
      source: effectiveSource,
      count: effectiveCount,
      newPostsProcessed: totalNew,
    });
    this.log("paused: waiting for next tick", {
      nextTickAt: nextTickAtIso,
      nextTickInMinutes: tickIntervalMinutes,
    });
    this.log("next action: next tick", {
      at: nextTickAtIso,
      inMinutes: tickIntervalMinutes,
    });
    this.log("next Moltbook activity (feed check, AI decision, possible post/comment/vote)", {
      at: nextTickAtIso,
      inMinutes: tickIntervalMinutes,
    });
  }

  private buildContextForPost(
    submoltName: string,
    post: Post,
    comments: Comment[],
    memory: MemoryStore
  ): DecisionContext {
    const { recentAgentMemory } = memory.getContext();
    const threadContent = [post.title, post.content].filter(Boolean).join("\n\n");
    const commentList = comments.slice(-30).map((c) => ({
      id: c.id,
      authorId: c.author?.name ?? "?",
      content: c.content,
    }));
    return {
      submoltId: submoltName,
      threadId: post.id,
      threadContent: threadContent || undefined,
      comments: commentList.length > 0 ? commentList : undefined,
      recentAgentMemory: recentAgentMemory.length > 0 ? recentAgentMemory : undefined,
    };
  }

  /** When no new posts: ask AI to refresh submolts, search, or skip; then run the chosen action. */
  private async askExploreAndExecute(
    processPost: (post: Post, submoltName: string) => Promise<void>
  ): Promise<"refresh" | "search" | "skip"> {
    const { llm } = this.deps;
    let choice: { action: string; query?: string };
    try {
      choice = await llm.decideExploreAction();
    } catch (err) {
      this.log("explore decision failed", { error: String(err) });
      return "skip";
    }
    if (choice.action === "refresh_submolts") {
      const did = await this.askRefreshSubmoltsAndSubscribe();
      return did ? "refresh" : "skip";
    }
    if (choice.action === "search" && choice.query?.trim()) {
      await this.runSearchAndProcess(choice.query.trim(), processPost);
      return "search";
    }
    this.log("AI chose skip (no refresh, no search)", {});
    return "skip";
  }

  /** Run semantic search and process each post result (ask AI for action). Logs exact query and results; if no post results, asks AI to simplify query and retries up to 3 times. */
  private async runSearchAndProcess(
    query: string,
    processPost: (post: Post, submoltName: string) => Promise<void>
  ): Promise<void> {
    const { moltbook, llm } = this.deps;
    const MAX_SIMPLIFY_RETRIES = 3;
    let currentQuery = query;
    let results: SearchResult[] = [];
    let postResults: SearchResult[] = [];

    for (let attempt = 0; attempt <= MAX_SIMPLIFY_RETRIES; attempt++) {
      this.log("searching Moltbook (semantic)", { exactQuery: currentQuery, attempt: attempt + 1 });
      try {
        results = await moltbook.search(currentQuery, "all", 20);
      } catch (err) {
        this.log("search failed", { exactQuery: currentQuery, error: String(err) });
        return;
      }
      const resultSummary = results.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title ?? null,
        similarity: r.similarity,
        author: r.author?.name,
        submolt: r.submolt && typeof r.submolt === "object" && "name" in r.submolt ? r.submolt.name : undefined,
      }));
      this.log("search results", {
        exactQuery: currentQuery,
        totalCount: results.length,
        results: resultSummary,
      });
      postResults = results.filter((r) => r.type === "post");
      if (postResults.length > 0) break;
      if (attempt < MAX_SIMPLIFY_RETRIES) {
        this.log("no post results; asking AI to simplify search query", { exactQuery: currentQuery, attempt: attempt + 1 });
        try {
          currentQuery = await llm.simplifySearchQuery(currentQuery);
          this.log("retrying search with simplified query", { simplifiedQuery: currentQuery });
        } catch (err) {
          this.log("simplify search query failed", { error: String(err) });
          return;
        }
      }
    }

    for (const r of postResults) {
      const submoltName = (r.submolt && typeof r.submolt === "object" && "name" in r.submolt ? r.submolt.name : undefined) ?? "general";
      const post: Post = {
        id: r.id,
        title: r.title ?? "",
        content: r.content ?? "",
        submolt: submoltName,
        author: r.author,
        created_at: r.created_at ?? "",
      };
      await processPost(post, submoltName);
    }
  }

  /** Fetch submolts, ask AI which to subscribe to, then subscribe. (Called when explore choice is refresh_submolts.) */
  private async askRefreshSubmoltsAndSubscribe(): Promise<boolean> {
    const { moltbook, llm } = this.deps;
    this.log("refreshing submolt list: fetching submolts and asking AI which to subscribe to", {});
    let all: Submolt[];
    try {
      all = await moltbook.getSubmolts();
      this.log("submolts fetched for refresh", { count: all.length, names: all.map((s) => s.name) });
    } catch (err) {
      this.log("getSubmolts failed during refresh", { error: String(err) });
      return false;
    }
    if (all.length === 0) {
      this.log("no submolts available to subscribe", {});
      return true;
    }
    let toSubscribe: string[];
    try {
      toSubscribe = await llm.chooseSubmoltsToSubscribe(all);
    } catch (err) {
      this.log("chooseSubmoltsToSubscribe failed during refresh", { error: String(err) });
      return true;
    }
    for (const name of toSubscribe) {
      try {
        await moltbook.subscribeSubmolt(name);
        this.log("subscribed (refresh)", { submolt: name });
      } catch (err) {
        this.log("subscribe failed during refresh", { submolt: name, error: String(err) });
      }
    }
    return true;
  }

  /** When a submolt has no new posts, ask AI whether to post there; if yes, run policy and post. */
  private async askProactivePostAndExecute(submolt: Submolt): Promise<void> {
    const { moltbook, llm, policy, memory, config } = this.deps;
    let decision;
    try {
      decision = await llm.decideProactivePost(submolt.name, {
        display_name: submolt.display_name,
        description: submolt.description,
      });
    } catch (err) {
      this.log("proactive post decision failed", { submolt: submolt.name, error: String(err) });
      return;
    }
    if (decision.action !== "post" || !decision.title || !decision.content) {
      this.log("proactive post: AI chose skip", { submolt: submolt.name });
      return;
    }
    const title = decision.title;
    const content = decision.content;
    if (memory.isDuplicatePost(title, content)) {
      this.log("proactive post blocked (duplicate)", { submolt: submolt.name });
      return;
    }
    const lastPostAt = memory.getLastPostAt();
    if (lastPostAt) {
      const elapsedMs = Date.now() - new Date(lastPostAt).getTime();
      const requiredMs = config.postIntervalMinutes * 60 * 1000;
      if (elapsedMs < requiredMs) {
        this.log("proactive post blocked (rate limit)", { submolt: submolt.name, waitMinutes: Math.ceil((requiredMs - elapsedMs) / 60000) });
        return;
      }
    }
    if (config.dryRun) {
      this.log("dry run: would post proactively", { submolt: submolt.name, title: title.slice(0, 50) });
      return;
    }
    try {
      this.log("posting proactively to Moltbook...", { submolt: submolt.name, title: title.slice(0, 50) });
      const p = await moltbook.postPost(submolt.name, title, content);
      memory.addAgentPostId(p.id);
      memory.addAgentPostContent(title, content);
      memory.setLastPostAt(new Date().toISOString());
      policy.recordAction("post", { submoltId: submolt.name, content });
      this.log("posted (proactive)", { postId: p.id, submolt: submolt.name });
    } catch (err) {
      this.log("proactive post failed", { submolt: submolt.name, error: String(err) });
    }
  }

  private async decideAndExecute(
    context: DecisionContext,
    postId: string,
    submoltName: string,
    commentId: string | undefined
  ): Promise<{ decision: import("../types/decision.js").Decision; outcome: "executed" | "blocked" | "skipped" } | null> {
    const { moltbook, llm, policy, memory, config } = this.deps;
    void commentId;

    this.log("contacting AI model for decision", { postId, submolt: submoltName });
    let decision;
    try {
      decision = await llm.decideAction(context);
      this.log("AI model responded", { postId, action: decision.action, confidence: decision.confidence });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("AI model unavailable or request failed", {
        error: msg,
        postId,
        hint: msg.includes("429") ? "Quota exceeded — check plan and billing" : "Check OPENAI_API_KEY and network",
      });
      return null;
    }

    this.log("policy check", { action: decision.action });
    const actionSource =
      decision.action === "post"
        ? "post"
        : decision.action === "comment"
          ? "comment"
          : decision.action === "vote"
            ? "vote"
            : "ignore";

    const verdict = policy.validate(decision, {
      submoltId: submoltName,
      threadId: postId,
      actionSource,
    });

    if (!verdict.allowed) {
      this.log("policy blocked", {
        action: decision.action,
        reason: verdict.reason,
        postId,
      });
      return { decision, outcome: "blocked" };
    }

    if (decision.action === "post" && decision.content) {
      const title = decision.title ?? (decision.content.slice(0, 80) || "Post");
      if (memory.isDuplicatePost(title, decision.content)) {
        this.log("policy blocked", {
          action: "post",
          reason: "duplicate of previous post",
          postId,
        });
        return { decision, outcome: "blocked" };
      }
      const lastPostAt = memory.getLastPostAt();
      if (lastPostAt) {
        const elapsedMs = Date.now() - new Date(lastPostAt).getTime();
        const requiredMs = config.postIntervalMinutes * 60 * 1000;
        if (elapsedMs < requiredMs) {
          const waitMin = Math.ceil((requiredMs - elapsedMs) / 60000);
          this.log("policy blocked", {
            action: "post",
            reason: `post rate limit (Moltbook: 1 post per ${config.postIntervalMinutes} min)`,
            postId,
            lastPostAt,
            waitMinutes: waitMin,
          });
          return { decision, outcome: "blocked" };
        }
      }
    }

    if (decision.action === "ignore") {
      this.log("skipping (ignore)", { postId });
      return { decision, outcome: "skipped" };
    }

    if (config.dryRun) {
      this.log("dry run: would execute", {
        action: decision.action,
        targetId: decision.targetId,
        postId,
      });
      return { decision, outcome: "skipped" };
    }

    this.log("executing action", { action: decision.action, postId });
    try {
      if (decision.action === "post" && decision.content) {
        const title = decision.title ?? (decision.content.slice(0, 80) || "Post");
        this.log("posting to Moltbook...", { submolt: submoltName, title: title.slice(0, 50) });
        const p = await moltbook.postPost(submoltName, title, decision.content);
        memory.addAgentPostId(p.id);
        memory.addAgentPostContent(title, decision.content);
        memory.setLastPostAt(new Date().toISOString());
        policy.recordAction("post", { submoltId: submoltName, content: decision.content });
        this.log("posted", { postId: p.id, submolt: submoltName });
      } else if (decision.action === "comment" && decision.content) {
        const targetPostId = decision.targetId ?? postId;
        this.log("posting comment to Moltbook...", { targetPostId });
        const c = await moltbook.postComment(targetPostId, decision.content);
        memory.addAgentCommentId(c.id);
        policy.recordAction("comment", { threadId: targetPostId, content: decision.content });
        this.log("commented", { commentId: c.id, postId: targetPostId });
      } else if (decision.action === "vote" && decision.targetId && decision.voteDirection) {
        const targetType = decision.targetId === postId ? "post" : "comment";
        this.log("voting on Moltbook...", { targetId: decision.targetId, direction: decision.voteDirection, targetType });
        await moltbook.vote(decision.targetId, decision.voteDirection, targetType);
        this.log("voted", {
          targetId: decision.targetId,
          direction: decision.voteDirection,
          targetType,
        });
      }
    } catch (err) {
      this.log("execute failed", {
        action: decision.action,
        error: String(err),
        postId,
      });
      return { decision, outcome: "blocked" };
    }

    return { decision, outcome: "executed" };
  }
}
