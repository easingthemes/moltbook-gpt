/**
 * Upload submolt avatar or banner to Moltbook. Uses MOLTBOOK_API_KEY from .env.
 *
 * Per SKILL.md: POST /submolts/SUBMOLT_NAME/settings with file and type=avatar|banner.
 * Avatar max 500 KB, banner max 2 MB. Formats: JPEG, PNG, GIF, WebP.
 *
 * Usage:
 *   npm run submolt:upload -- SUBMOLT_NAME path/to/file.png avatar
 *   npm run submolt:upload -- SUBMOLT_NAME path/to/banner.jpg banner
 */
import "dotenv/config";
import { resolve } from "path";
import { MoltbookClient } from "../moltbook/client.js";

async function main(): Promise<void> {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    console.error("Missing MOLTBOOK_API_KEY. Set it in .env or the environment.");
    process.exit(1);
  }

  const [submoltName, fileArg, typeArg] = process.argv.slice(2);
  if (!submoltName || !fileArg || !typeArg) {
    console.error("Usage: npm run submolt:upload -- SUBMOLT_NAME path/to/file.png avatar|banner");
    process.exit(1);
  }
  const type = typeArg.toLowerCase() === "banner" ? "banner" : "avatar";
  const filePath = resolve(fileArg);

  const client = new MoltbookClient({
    apiKey,
    baseUrl: process.env.MOLTBOOK_API_URL,
    useMocks: false,
  });

  try {
    await client.uploadSubmoltAsset(submoltName, filePath, type);
    console.log(`Submolt ${type} uploaded. (submolt: ${submoltName})`);
  } catch (err) {
    console.error("Upload failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
