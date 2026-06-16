import "dotenv/config";

import { AGENT_CONFIG, DELIVEROO_CONFIG, INSTANCES, validateConfig } from "./config.js";
import { setupBeliefUpdates } from "./beliefs/updateBeliefs.js";
import { createBeliefState } from "./beliefs/beliefState.js";
import { createActions } from "./actions/actions.js";
import { createLLMState } from "./llm/llmState.js";
import { startBDIAgent } from "./bdi/bdiAgent.js";
import { startLLMAgent } from "./llm/agent.js";
import { createSocket } from "./socket.js";


validateConfig();

console.log(`Starting ${INSTANCES.length} agent instance(s) (mode: ${INSTANCES[0].mode})`);

for (const instance of INSTANCES) {
  if (instance.mode === "MULTI") {
    const bdiSocket = createSocket(DELIVEROO_CONFIG.host, instance.tokenBdi);
    const bdibs = createBeliefState();
    const bdiActions = createActions(bdiSocket, bdibs);
    setupBeliefUpdates(bdiSocket, bdibs);

    const llmSocket = createSocket(DELIVEROO_CONFIG.host, instance.tokenLlm);
    const llmbs = createBeliefState();
    const llmState = createLLMState();
    const llmActions = createActions(llmSocket, llmbs);

    setupBeliefUpdates(llmSocket, llmbs);

    bdibs.partner = llmbs.me;
    llmbs.partner = bdibs.me;

    startBDIAgent(bdiSocket, bdibs, bdiActions);
    startLLMAgent(llmSocket, llmbs, llmState, llmActions);
  } else if (instance.mode === "LLM") {
    const llmSocket = createSocket(DELIVEROO_CONFIG.host, instance.tokenLlm);
    const llmbs = createBeliefState();
    const llmState = createLLMState();
    const llmActions = createActions(llmSocket, llmbs);
    setupBeliefUpdates(llmSocket, llmbs);

    startLLMAgent(llmSocket, llmbs, llmState, llmActions);
  } else {
    const bdiSocket = createSocket(DELIVEROO_CONFIG.host, instance.tokenBdi);
    const bdibs = createBeliefState();
    const bdiActions = createActions(bdiSocket, bdibs);
    setupBeliefUpdates(bdiSocket, bdibs);

    startBDIAgent(bdiSocket, bdibs, bdiActions);
  }
}
