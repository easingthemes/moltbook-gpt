/**
 * Subscribe to submolts. Uses MOLTBOOK_API_KEY from .env.
 *
 * Usage:
 *   npm run submolt:subscribe
 *   npm run submolt:subscribe -- general tech
 *
 * When no names are given (no args and no SUBSCRIBE_SUBMOLTS): the AI model decides which
 * submolts to subscribe to based on instructions.md and the list from GET /submolts.
 * When names are given (env or argv): subscribes to those names only.
 */
import "dotenv/config";
import { MoltbookClient } from "../moltbook/client.js";
import { ChatGPTClient } from "../llm/chatgpt-client.js";
import { loadInstructionsFromFile, loadMoltbookSkillFromFile } from "../llm/prompts.js";

function getExplicitSubmoltNames(): string[] | null {
  const fromEnv = process.env.SUBSCRIBE_SUBMOLTS?.trim();
  if (fromEnv) {
    return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const fromArgv = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
  if (fromArgv.length > 0) return fromArgv;
  return null;
}

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

  try {
    console.log("Fetching submolts (GET /submolts)...");
    const all = await client.getSubmolts();
    console.log("Submolts available:", all.length, all.map((s) => s.name));

    let toSubscribe: string[];
    const explicit = getExplicitSubmoltNames();
    if (explicit !== null && explicit.length > 0) {
      toSubscribe = explicit;
      console.log("Subscribing to (from env/argv):", toSubscribe.join(", "));
    } else {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        console.error("No submolt names given and OPENAI_API_KEY is missing. Set SUBSCRIBE_SUBMOLTS or pass names, or set OPENAI_API_KEY for model to decide.");
        process.exit(1);
      }
      const instructionsPath = process.env.AGENT_INSTRUCTIONS_PATH;
      const customInstructions = loadInstructionsFromFile(instructionsPath);
      if (!customInstructions) {
        console.error("instructions.md (or AGENT_INSTRUCTIONS_PATH) is required for model to choose submolts.");
        process.exit(1);
      }
      const moltbookContext = loadMoltbookSkillFromFile(process.env.MOLTBOOK_SKILL_PATH);
      const llm = new ChatGPTClient({
        apiKey: openaiKey,
        model: process.env.OPENAI_MODEL,
        customInstructions,
        moltbookContext,
      });
      console.log("Asking AI model which submolts to subscribe to...");
      toSubscribe = await llm.chooseSubmoltsToSubscribe(all);
      console.log("Model chose:", toSubscribe.length ? toSubscribe.join(", ") : "(none)");
    }

    for (const name of toSubscribe) {
      try {
        await client.subscribeSubmolt(name);
        console.log("Subscribed:", name);
      } catch (err) {
        console.error("Subscribe failed:", name, err instanceof Error ? err.message : err);
      }
    }

    console.log("Done.");
  } catch (err) {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
