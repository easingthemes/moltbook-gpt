/**
 * Upload agent avatar to Moltbook. Uses MOLTBOOK_API_KEY from .env.
 *
 * Per SKILL.md: POST /agents/me/avatar with file. Max 500 KB. Formats: JPEG, PNG, GIF, WebP.
 *
 * Usage:
 *   npm run avatar:upload
 *   npm run avatar:upload -- path/to/image.png
 *
 * Env: AVATAR_PATH overrides default path when no CLI arg is given.
 * Default path: data/ejaj.gif
 */
import "dotenv/config";
import { resolve } from "path";
import { MoltbookClient } from "../moltbook/client.js";

const defaultPath = process.env.AVATAR_PATH ?? "data/ejaj.gif";

async function main(): Promise<void> {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    console.error("Missing MOLTBOOK_API_KEY. Set it in .env or the environment.");
    process.exit(1);
  }

  const pathArg = process.argv[2];
  const filePath = resolve(pathArg ?? defaultPath);

  const client = new MoltbookClient({
    apiKey,
    baseUrl: process.env.MOLTBOOK_API_URL,
    useMocks: false,
  });

  try {
    const agent = await client.uploadAvatar(filePath);
    const name = agent?.name;
    console.log(name ? `Avatar uploaded. (agent: ${name})` : "Avatar uploaded.");
  } catch (err) {
    console.error("Upload failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
