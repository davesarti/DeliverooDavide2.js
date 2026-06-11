import "dotenv/config";

export const LLM_CONFIG = {
  baseURL: process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1",
  apiKey: process.env.LITELLM_API_KEY,
  model: process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio",
};

export const DELIVEROO_CONFIG = {
  host: process.env.HOST,
  tokenBdi: process.env.TOKEN_BDI,
  tokenLlm: process.env.TOKEN_LLM,
};

export const AGENT_CONFIG = {
  // "BDI"  → starts only the BDI (uses TOKEN_BDI)
  // "LLM"  → starts only the LLM (uses TOKEN_LLM)
  // "BOTH" → starts both (uses TOKEN_BDI and TOKEN_LLM)
  mode: "LLM",

  pathfinding: {
    algorithm: "bfs",
  },
};

/*
 * Checks that environment variables and base options are consistent.
 */
export function validateConfig() {
  if (!DELIVEROO_CONFIG.host) {
    throw new Error("Missing HOST");
  }

  if (!["BDI", "LLM", "BOTH"].includes(AGENT_CONFIG.mode)) {
    throw new Error("AGENT_CONFIG.mode must be BDI, LLM, or BOTH");
  }

  if (!["bfs", "astar"].includes(AGENT_CONFIG.pathfinding.algorithm)) {
    throw new Error("AGENT_CONFIG.pathfinding.algorithm must be bfs or astar");
  }

  if (AGENT_CONFIG.mode === "BDI" || AGENT_CONFIG.mode === "BOTH") {
    if (!DELIVEROO_CONFIG.tokenBdi) {
      throw new Error("Missing TOKEN_BDI");
    }
  }

  if (AGENT_CONFIG.mode === "LLM" || AGENT_CONFIG.mode === "BOTH") {
    if (!DELIVEROO_CONFIG.tokenLlm) {
      throw new Error("Missing TOKEN_LLM");
    }
    if (!LLM_CONFIG.apiKey) {
      throw new Error("Missing LITELLM_API_KEY");
    }
  }
}