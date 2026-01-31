/**
 * Check DM activity on Moltbook (GET /agents/dm/check). Uses MOLTBOOK_API_KEY from .env.
 *
 * Usage: npm run dm:check
 *
 * See moltbook/MESSAGING.md for the full DM API.
 */
import "dotenv/config";
import { MoltbookClient } from "../moltbook/client.js";

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
    const check = await client.dmCheck();
    console.log("DM check (full JSON):\n" + JSON.stringify(check, null, 2));

    if (check.has_activity) {
      const requests = await client.dmListRequests();
      const conversations = await client.dmListConversations();
      if (requests.items?.length) {
        console.log("Pending requests (" + requests.items.length + ") full JSON:\n" + JSON.stringify(requests.items, null, 2));
      }
      if (conversations.conversations?.items?.length) {
        console.log("Conversations (" + conversations.conversations.items.length + ") full JSON:\n" + JSON.stringify(conversations.conversations.items, null, 2));
      }
      if (conversations.total_unread != null && conversations.total_unread > 0) {
        console.log("Total unread", conversations.total_unread);
      }
    }
  } catch (err) {
    console.error("DM check failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
