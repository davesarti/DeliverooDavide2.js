import "dotenv/config";

export const LLM_CONFIG = {
  baseURL: process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1",
  apiKey: process.env.LITELLM_API_KEY,
  model: process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio",
};

export const DELIVEROO_CONFIG = {
  host: process.env.HOST,
};

export const AGENT_CONFIG = {
  pathfinding: {
    algorithm: "bfs",
  },
};

/*
 * Collects all values for a token prefix.
 * Tries TOKEN_BDI_1, TOKEN_BDI_2, ... then falls back to TOKEN_BDI.
 */
function collectTokens(prefix) {
  const tokens = [];
  for (let i = 1; ; i++) {
    const t = process.env[`${prefix}_${i}`];
    if (!t) break;
    tokens.push(t);
  }
  if (tokens.length === 0 && process.env[prefix]) {
    tokens.push(process.env[prefix]);
  }
  return tokens;
}

function parseArgv() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && argv[i + 1]) args.mode = argv[++i];
    if (argv[i] === "--count" && argv[i + 1]) args.count = argv[++i];
  }
  return args;
}

/*
 * Builds the list of agent instances from env vars (or CLI --mode / --count overrides).
 * AGENT_MODE: BDI | LLM | MULTI (default MULTI)
 * AGENT_COUNT: optional, caps the number of instances
 */
function buildInstances() {
  const argv = parseArgv();
  const rawMode = (argv.mode || process.env.AGENT_MODE || "MULTI").toUpperCase();
  if (!["BDI", "LLM", "MULTI"].includes(rawMode)) {
    throw new Error("AGENT_MODE must be BDI, LLM, or MULTI");
  }

  const bdiTokens = collectTokens("TOKEN_BDI");
  const llmTokens = collectTokens("TOKEN_LLM");

  const instances = [];

  if (rawMode === "MULTI") {
    const count = Math.min(bdiTokens.length, llmTokens.length);
    for (let i = 0; i < count; i++) {
      instances.push({ mode: "MULTI", tokenBdi: bdiTokens[i], tokenLlm: llmTokens[i] });
    }
  } else if (rawMode === "LLM") {
    for (const token of llmTokens) {
      instances.push({ mode: "LLM", tokenLlm: token });
    }
  } else {
    for (const token of bdiTokens) {
      instances.push({ mode: "BDI", tokenBdi: token });
    }
  }

  const rawCount = argv.count ?? process.env.AGENT_COUNT;
  if (rawCount !== undefined) {
    const requestedCount = parseInt(rawCount, 10);
    if (isNaN(requestedCount) || requestedCount < 1) {
      throw new Error("AGENT_COUNT must be a positive integer");
    }
    if (requestedCount > instances.length) {
      throw new Error(
        `AGENT_COUNT=${requestedCount} but only ${instances.length} complete token set(s) available for mode ${rawMode}`
      );
    }
    instances.splice(requestedCount);
  }

  return instances;
}

export const INSTANCES = buildInstances();

/*
 * Checks that environment variables and base options are consistent.
 */
export function validateConfig() {
  if (!DELIVEROO_CONFIG.host) {
    throw new Error("Missing HOST");
  }

  if (INSTANCES.length === 0) {
    throw new Error("No agent instances configured — check TOKEN_BDI / TOKEN_LLM in .env");
  }

  if (!["bfs", "astar"].includes(AGENT_CONFIG.pathfinding.algorithm)) {
    throw new Error("AGENT_CONFIG.pathfinding.algorithm must be bfs or astar");
  }

  if (INSTANCES.some((i) => i.mode !== "BDI") && !LLM_CONFIG.apiKey) {
    throw new Error("Missing LITELLM_API_KEY (required when AGENT_MODE uses LLM)");
  }
}
