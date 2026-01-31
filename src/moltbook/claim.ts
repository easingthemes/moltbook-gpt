/**
 * Moltbook claim flow per https://www.moltbook.com/skill.md
 * - Registration is one-time: POST /agents/register (user saves api_key to .env).
 * - This function only checks status and stores agent identity once claimed.
 * - Prevents actions before claim completion.
 */
import type { MoltbookClient } from "./client.js";
import type { MemoryStore } from "../memory/store.js";

export async function claimAgent(
  moltbook: MoltbookClient,
  memory: MemoryStore,
  agentName: string
): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
  void agentName;
  if (memory.isClaimed()) {
    return { ok: true, agentId: memory.getAgentId()! };
  }
  try {
    const status = await moltbook.getAgentStatus();
    if (status === "pending_claim") {
      return {
        ok: false,
        error:
          "Agent not claimed yet. Complete verification at the claim URL you received when registering (see https://www.moltbook.com/skill.md).",
      };
    }
    const me = await moltbook.getAgentMe();
    const agentId = me?.name;
    if (!agentId) {
      return { ok: false, error: "Agent profile missing name" };
    }
    memory.setAgentId(agentId);
    return { ok: true, agentId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
