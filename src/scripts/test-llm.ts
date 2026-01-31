/**
 * Test connection to OpenAI (ChatGPT). Uses OPENAI_API_KEY and optional OPENAI_MODEL from .env.
 *
 * Usage:
 *   npm run llm:test
 *   OPENAI_MODEL=gpt-5.1-instant npm run llm:test
 *
 * Default model: gpt-4o-mini. Set OPENAI_MODEL to test another model (e.g. gpt-5.1-instant).
 */
import "dotenv/config";
import OpenAI from "openai";

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY. Set it in .env or the environment.");
    process.exit(1);
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const openai = new OpenAI({ apiKey });

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "user", content: "Reply with exactly: OK" },
      ],
      max_completion_tokens: 10,
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    console.log("model:", model);
    console.log("response:", content);
    console.log("Connection OK.");
  } catch (err) {
    console.error("Connection failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
