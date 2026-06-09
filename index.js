import "dotenv/config";

import { AGENT_CONFIG, validateConfig } from "./config.js";
import "./beliefs/updateBeliefs.js";

import { startLLMAgent } from "./llm/agent.js";

// import { startBDIAgent } from "./bdi/agent.js";

validateConfig();

console.log("Agent starting...");
console.log(`Selected mode: ${AGENT_CONFIG.mode}`);

if (AGENT_CONFIG.mode === "LLM") {
  console.log("Starting LLM agent");
  startLLMAgent();
} else if (AGENT_CONFIG.mode === "BDI") {
  console.log("Starting BDI agent");

  // startBDIAgent();

  throw new Error("BDI agent is not implemented in the new structure yet");
} else {
  throw new Error(`Unknown agent mode: ${AGENT_CONFIG.mode}`);
}