import "dotenv/config";

import { AGENT_CONFIG, DELIVEROO_CONFIG, validateConfig } from "./config.js";
import { createSocket } from "./socket.js";
import { createBeliefState } from "./beliefs/beliefState.js";
import { setupBeliefUpdates } from "./beliefs/updateBeliefs.js";
import { createActions } from "./actions/actions.js";
import { startBDIAgent } from "./bdi/bdiAgent.js";
import { startLLMAgent } from "./llm/agent.js";

validateConfig();

console.log(`Starting in mode: ${AGENT_CONFIG.mode}`);

if (AGENT_CONFIG.mode === "BDI") {

  const socket = createSocket(DELIVEROO_CONFIG.host, DELIVEROO_CONFIG.tokenBdi);
  const bs = createBeliefState();
  const actions = createActions(socket, bs);
  setupBeliefUpdates(socket, bs);
  startBDIAgent(socket, bs, actions);

} else if (AGENT_CONFIG.mode === "LLM") {

  const socket = createSocket(DELIVEROO_CONFIG.host, DELIVEROO_CONFIG.tokenLlm);
  const bs = createBeliefState();
  const actions = createActions(socket, bs);
  setupBeliefUpdates(socket, bs);
  startLLMAgent(socket, bs, actions);

} else if (AGENT_CONFIG.mode === "BOTH") {

  // Agente BDI
  const bdiSocket = createSocket(DELIVEROO_CONFIG.host, DELIVEROO_CONFIG.tokenBdi);
  const bdibs = createBeliefState();
  const bdiActions = createActions(bdiSocket, bdibs);
  setupBeliefUpdates(bdiSocket, bdibs);

  // Agente LLM
  const llmSocket = createSocket(DELIVEROO_CONFIG.host, DELIVEROO_CONFIG.tokenLlm);
  const llmbs = createBeliefState();
  const llmActions = createActions(llmSocket, llmbs);
  setupBeliefUpdates(llmSocket, llmbs);

  // I due agenti si puntano a vicenda
  bdibs.partner = llmbs.me;
  llmbs.partner = bdibs.me;

  // Avvia entrambi in parallelo
  startBDIAgent(bdiSocket, bdibs, bdiActions);
  startLLMAgent(llmSocket, llmbs, llmActions);

}