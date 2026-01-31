/**
 * List all comments from this bot. Uses MOLTBOOK_API_KEY from .env.
 *
 * Usage: npm run comments:list
 *
 * 1) Lists comment IDs and context from memory (agentCommentIds + recentDecisions where action=comment).
 * 2) If possible, fetches comments from API: gets agent name from GET /agents/me, then semantic search
 *    with type=comments and query=agent name, filters by author and prints those.
 */
import "dotenv/config";
import { MoltbookClient } from "../moltbook/client.js";
import { MemoryStore } from "../memory/store.js";
import type { SearchResult } from "../types/moltbook.js";

async function main(): Promise<void> {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    console.error("Missing MOLTBOOK_API_KEY. Set it in .env or the environment.");
    process.exit(1);
  }

  const client = new MoltbookClient({
    apiKey,
    baseUrl: process.env.MOLTBOOK_API_URL,
    useMocks: false,
  });

  const memory = new MemoryStore();
  await memory.load();
  const { agentCommentIds, recentDecisions } = memory.getContext();

  console.log("--- Comments from memory (this run) ---");
  if (agentCommentIds.length === 0) {
    console.log("No comment IDs stored in memory.");
  } else {
    const commentDecisions = recentDecisions.filter((d) => d.decision.action === "comment");
    for (const id of agentCommentIds) {
      const ctx = commentDecisions.find((d) => d.decision.targetId === id || d.context.threadId);
      const thread = ctx?.context.threadId ?? "?";
      const outcome = ctx?.outcome ?? "?";
      console.log(`  ${id}  (thread: ${thread}, outcome: ${outcome})`);
    }
  }

  console.log("\n--- Comments from API (search by agent name) ---");
  try {
    const me = await client.getAgentMe();
    const agentName = me?.name?.trim();
    if (!agentName) {
      console.log("Could not get agent name from GET /agents/me.");
      return;
    }
    console.log(`Agent name: ${agentName}. Searching comments (type=comments, query="${agentName}")...`);
    const results = await client.search(agentName, "comments", 50);
    const myComments = results.filter(
      (r: SearchResult) => r.type === "comment" && r.author?.name === agentName
    );
    if (myComments.length === 0) {
      console.log("No comments found by search (semantic search may not match by author; try listing from memory above).");
      return;
    }
    console.log(`Found ${myComments.length} comment(s):\n`);
    for (const r of myComments) {
      const postTitle = r.post?.title ?? r.post_id ?? "?";
      const content = (r.content ?? "").slice(0, 120);
      console.log(`  id: ${r.id}`);
      console.log(`  post: ${postTitle}`);
      console.log(`  content: ${content}${(r.content?.length ?? 0) > 120 ? "..." : ""}`);
      console.log(`  created_at: ${r.created_at ?? "?"}\n`);
    }
  } catch (err) {
    console.error("API fetch failed:", err instanceof Error ? err.message : err);
  }
}

main();
