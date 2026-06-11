import "dotenv/config";

import { AGENT_CONFIG, DELIVEROO_CONFIG, INSTANCES, validateConfig } from "./config.js";
import { createSocket } from "./socket.js";
import { createBeliefState } from "./beliefs/beliefState.js";
import { setupBeliefUpdates } from "./beliefs/updateBeliefs.js";
import { createActions } from "./actions/actions.js";
import { startBDIAgent } from "./bdi/bdiAgent.js";
import { startLLMAgent } from "./llm/agent.js";

validateConfig();

console.log(`Starting ${INSTANCES.length} agent instance(s) (mode: ${INSTANCES[0].mode})`);

for (const instance of INSTANCES) {
  const bdiSocket = createSocket(DELIVEROO_CONFIG.host, instance.tokenBdi);
  const bdibs = createBeliefState();
  const bdiActions = createActions(bdiSocket, bdibs);
  setupBeliefUpdates(bdiSocket, bdibs);

  if (instance.mode === "MULTI") {
    const llmSocket = createSocket(DELIVEROO_CONFIG.host, instance.tokenLlm);
    const llmbs = createBeliefState();
    const llmActions = createActions(llmSocket, llmbs);
    setupBeliefUpdates(llmSocket, llmbs);

    bdibs.partner = llmbs.me;
    llmbs.partner = bdibs.me;

    startBDIAgent(bdiSocket, bdibs, bdiActions);
    startLLMAgent(llmSocket, llmbs, llmActions);
  } else {
    startBDIAgent(bdiSocket, bdibs, bdiActions);
  }
}
