import { callLLMTool } from "./client.js";
import {MAX_ITERATIONS, MAX_MISSION_HISTORY} from "../utils/constants.js";
import { SYSTEM_PROMPT, buildMissionUserPrompt, MISSION_TOOLS } from "./prompts.js";
import { calculate, getMyPosition, findDeliveryTile, get_environment_state, updatePersistentMemory, blockTile, unblockTile } from "./tools.js";

// ==========================================
// Logging
// ==========================================

function timestamp() {
  return new Date().toISOString();
}

function logWithTime(name, ...args) {
  console.log(`[${timestamp()}] [${name ?? "LLM"}]`, ...args);
}

// ==========================================
// Tool execution
// ==========================================

/*
 * Esegue l'azione atomica scelta dal modello e restituisce l'osservazione.
 * action = { name: string, params: object }
 */
async function executeTool(action, bs, actions) {
  const { name, params } = action;

  switch (name) {

    case "calculate":
      return calculate(params);

    case "get_my_position":
      return getMyPosition(bs);

    case "find_delivery_tile":
      return findDeliveryTile(params, bs);

    case "go_to": {
      try {
        await actions.goTo(params.x, params.y);
        return `Arrived at (${params.x}, ${params.y}).`;
      } catch (error) {
        return `Could not reach (${params.x}, ${params.y}): ${error?.message ?? error}. The tile may be unreachable or outside the map.`;
      }
    }

    case "go_pick_up": {
      try {
        await actions.goPickUp(params.x, params.y, params.parcelId);
        return `Picked up parcel ${params.parcelId ?? ""} at (${params.x}, ${params.y}).`;
      } catch (error) {
        return `Could not pick up at (${params.x}, ${params.y}): ${error?.message ?? error}.`;
      }
    }

    case "go_drop_off": {
      try {
        await actions.goDropOff(params.x, params.y);
        return `Delivered parcels at (${params.x}, ${params.y}).`;
      } catch (error) {
        return `Could not deliver at (${params.x}, ${params.y}): ${error?.message ?? error}.`;
      }
    }

    case "explore": {
      try {
        await actions.explore();
        return "Exploration complete.";
      } catch (error) {
        return `Could not explore: ${error?.message ?? error}.`;
      }
    }

    case "get_environment_state":
      return get_environment_state(bs);
    
    case "update_persistent_memory":
      return await updatePersistentMemory(bs, params.text);
    
    case "block_tile":
      return blockTile(params, bs);

    case "unblock_tile":
      return unblockTile(params, bs);

    default:
      return `Unknown action: ${name}.`;
  }
}

// ==========================================
// Entry point
// ==========================================

/*
 * Salva la storia delle missioni completate, mantenendo solo le ultime N.
 */
function saveMissionHistory(bs, { request, reply }) {
  if (!Array.isArray(bs.missionHistory)) {
    bs.missionHistory = [];
  }

  bs.missionHistory.push({
    request,
    reply,
    completedAt: Date.now(),
  });

  if (bs.missionHistory.length > MAX_MISSION_HISTORY) {
    bs.missionHistory.shift();
  }
}

/*
 * Avvia il listener delle missioni speciali via chat.
 * Per ogni messaggio ricevuto esegue il loop ReAct mantenendo
 * una conversation history reale (ruoli assistant + tool),
 * finché il modello produce final_reply.
 */
export async function startLLMAgent(socket, bs, actions) {
  logWithTime(bs.me.name, "LLM chat listener started");

  socket.onMsg(async (id, name, msg) => {
    if (!msg || msg.trim() === "") return;
    if (id === bs.me.id) return;

    logWithTime(bs.me.name, `Mission from ${name} (${id}): ${msg}`);

    // Conversation history reale: cresce ad ogni iterazione.
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildMissionUserPrompt(msg, bs.persistentMemory, bs.missionHistory) },
    ];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const { action, toolCall } = await callLLMTool({
          messages,
          tools: MISSION_TOOLS,
          temperature: 0,
        });

        logWithTime(bs.me.name, `Action: ${action.name}(${JSON.stringify(action.params)})`);

        // Salva nella history la chiamata dell'assistant nel formato nativo.
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        });

        if (action.name === "final_reply") {
          await socket.emitSay(id, action.params.message);

          saveMissionHistory(bs, {
            request: msg,
            reply: action.params.message,
          });

          break;
        }

        const observation = await executeTool(action, bs, actions);
        logWithTime(bs.me.name, "Observation:", observation);

        // Salva nella history il risultato del tool nel ruolo "tool".
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: observation,
        });
      }
    } catch (error) {
      logWithTime(bs.me.name, "Mission error:", error?.message ?? error);
      try {
        await socket.emitSay(id, "Sorry, I could not complete the mission.");
      } catch {}
    }
  });
}