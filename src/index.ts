/**
 * Moltbook ↔ ChatGPT Agent
 * Long-running service; no UI. All LLM outputs are JSON only.
 */
import "dotenv/config";
import { loadEnv } from "./config/env.js";
import { MoltbookClient } from "./moltbook/client.js";
import { claimAgent } from "./moltbook/claim.js";
import { ChatGPTClient, RateLimiter } from "./llm/index.js";
import { loadInstructionsFromFile, loadMoltbookSkillFromFile } from "./llm/prompts.js";
import { PolicyEngine } from "./policy/index.js";
import { MemoryStore } from "./memory/index.js";
import { Scheduler } from "./scheduler/index.js";
import { createLogger } from "./logger.js";
import { appendAILog, truncateMeta } from "./ai-log-file.js";

async function main(): Promise<void> {
  const config = loadEnv();

  if (config.KILL_SWITCH) {
    console.warn("KILL_SWITCH is enabled. Exiting.");
    process.exit(0);
  }

  const baseLogger = createLogger("info");
  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => baseLogger.info(msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => baseLogger.warn(msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => baseLogger.error(msg, meta),
    decision: baseLogger.decision,
  };
  const processLog = (msg: string, meta?: Record<string, unknown>) => logger.info("[PROCESS] " + msg, meta);
  const processWarn = (msg: string, meta?: Record<string, unknown>) => logger.warn("[PROCESS] " + msg, meta);
  const processError = (msg: string, meta?: Record<string, unknown>) => logger.error("[PROCESS] " + msg, meta);
  const agentLog = (msg: string, meta?: Record<string, unknown>) => logger.info("[AGENT] " + msg, meta);

  processLog("agent starting", { agentName: config.AGENT_NAME });

  const moltbook = new MoltbookClient({
    apiKey: config.MOLTBOOK_API_KEY,
    baseUrl: config.MOLTBOOK_API_URL,
    useMocks: config.MOLTBOOK_USE_MOCKS ?? false,
    onLog: agentLog,
  });

  const rateLimiter = new RateLimiter({ maxCallsPerMinute: 20 });
  const instructionsPath = process.env.AGENT_INSTRUCTIONS_PATH;
  processLog("loading instructions", { path: instructionsPath ?? "instructions.md" });
  const customInstructions = loadInstructionsFromFile(instructionsPath);
  if (!customInstructions) {
    const path = instructionsPath ?? "instructions.md";
    processError("instructions.md is required", {
      hint: `Create ${path} in the project root or set AGENT_INSTRUCTIONS_PATH to your instructions file.`,
    });
    process.exit(1);
  }
  processLog("loading Moltbook skill", { path: process.env.MOLTBOOK_SKILL_PATH ?? "moltbook/SKILL.md" });
  const moltbookContext = loadMoltbookSkillFromFile(
    process.env.MOLTBOOK_SKILL_PATH
  );
  const llm = new ChatGPTClient({
    apiKey: config.OPENAI_API_KEY,
    model: config.OPENAI_MODEL,
    rateLimiter,
    customInstructions,
    moltbookContext,
    onLog: (msg, meta) => {
      const truncated = meta != null ? truncateMeta(meta) : meta;
      logger.info(msg, truncated);
      appendAILog(msg, truncated);
    },
  });

  processLog("checking AI model connection...");
  try {
    await llm.checkConnection();
    processLog("AI model connected", { model: llm.modelId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    processError("AI model connection failed on start; skipping actions until next interval", {
      error: msg,
      hint: msg.includes("429") ? "Quota exceeded — check plan and billing at https://platform.openai.com/account/billing" : "Check OPENAI_API_KEY and network.",
    });
  }

  const policy = new PolicyEngine({
    confidenceThreshold: 0.6,
    maxPostsPerHour: 5,
    maxCommentsPerThread: 3,
    maxContentLength: 2000,
    cooldownMinutesPerSubmolt: 10,
  });

  const memory = new MemoryStore();
  processLog("loading memory", { path: process.env.MEMORY_FILE ?? "data/memory.json" });
  await memory.load();
  processLog("memory loaded");

  processLog("claiming agent...");
  const claim = await claimAgent(moltbook, memory, config.AGENT_NAME);
  if (!claim.ok) {
    processError("claim failed", { error: claim.error });
    process.exit(1);
  }
  processLog("agent claimed", { agentId: claim.agentId });

  const dryRun = config.DRY_RUN ?? false;
  const { agentPostIds } = memory.getContext();
  const firstPostSubmolt = process.env.FIRST_POST_SUBMOLT ?? "general";
  const firstPostTitle = process.env.FIRST_POST_TITLE ?? `Hello from ${config.AGENT_NAME}`;
  const firstPostContent =
    process.env.FIRST_POST_CONTENT ?? `Hi, I'm ${config.AGENT_NAME} — just joined Moltbook. 🦞`;

  // Post initial post at most once: only when we have no posts and haven't attempted before.
  if (agentPostIds.length === 0 && !memory.hasAttemptedFirstPost() && !dryRun) {
    memory.setFirstPostAttempted();
    try {
      const p = await moltbook.postPost(firstPostSubmolt, firstPostTitle, firstPostContent);
      memory.addAgentPostId(p.id);
      memory.addAgentPostContent(firstPostTitle, firstPostContent);
      memory.setLastPostAt(new Date().toISOString());
      await memory.save();
      processLog("first post", { postId: p.id, submolt: firstPostSubmolt });
    } catch (err) {
      await memory.save();
      processWarn("first post skipped (e.g. submolt missing or rate limit)", {
        error: String(err),
        submolt: firstPostSubmolt,
      });
    }
  }

  const scheduler = new Scheduler({
    moltbook,
    llm,
    policy,
    memory,
    config: {
      tickIntervalMinutes: config.TICK_INTERVAL_MINUTES,
      postIntervalMinutes: config.POST_INTERVAL_MINUTES,
      dryRun,
      usePersonalizedFeed: config.USE_PERSONALIZED_FEED ?? false,
    },
    onLog: agentLog,
  });

  processLog("starting scheduler...");
  scheduler.start();
  processLog("agent started", {
    agentName: config.AGENT_NAME,
    tickIntervalMinutes: config.TICK_INTERVAL_MINUTES,
    postIntervalMinutes: config.POST_INTERVAL_MINUTES,
    dryRun,
  });

  const shutdown = () => {
    processLog("shutting down");
    scheduler.stop();
    memory.save().catch((err) => processError("memory save on shutdown", { error: String(err) }));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
