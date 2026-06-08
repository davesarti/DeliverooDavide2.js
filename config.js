import "dotenv/config";

// ==========================================
// 1. LLM Configuration
// ==========================================

export const LLM_CONFIG = {
  baseURL: process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1",
  apiKey: process.env.LITELLM_API_KEY,
  model: "llama-3.3-70b-lmstudio",
};

// ==========================================
// 2. DeliverooJS Configuration
// ==========================================

export const DELIVEROO_CONFIG = {
  host: process.env.HOST,
  token: process.env.TOKEN,
};

// ==========================================
// 3. Agent Configuration
// ==========================================

export const AGENT_CONFIG = {
  mode: "LLM", // "BDI" | "LLM"

  pathfinding: {
    algorithm: "bfs", // "bfs" | "astar"
  },
};

// ==========================================
// 4. Validation
// ==========================================

export function validateConfig() {
  if (!DELIVEROO_CONFIG.host) {
    throw new Error("Missing HOST");
  }

  if (!DELIVEROO_CONFIG.token) {
    throw new Error("Missing TOKEN");
  }

  if (!["BDI", "LLM"].includes(AGENT_CONFIG.mode)) {
    throw new Error("AGENT_CONFIG.mode must be either BDI or LLM");
  }

  if (!["bfs", "astar"].includes(AGENT_CONFIG.pathfinding.algorithm)) {
    throw new Error("AGENT_CONFIG.pathfinding.algorithm must be either bfs or astar");
  }

  if (AGENT_CONFIG.mode === "LLM" && !LLM_CONFIG.apiKey) {
    throw new Error("Missing LITELLM_API_KEY because AGENT_CONFIG.mode is LLM");
  }
}