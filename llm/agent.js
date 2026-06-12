import { callLLMTool } from "./client.js";
import {MAX_ITERATIONS, MAX_MISSION_HISTORY} from "../utils/constants.js";
import { validateActionAgainstPersistentRules } from "./rulesValidator.js";
import { SYSTEM_PROMPT, buildMissionUserPrompt, MISSION_TOOLS } from "./prompts/index.js";
import {
  calculate,
  getMyPosition,
  findDeliveryTile,
  get_environment_state,
  setStackSize,
  removeStackSize,
  setParcelFilter,
  removeParcelFilter,
  forbidDeliveryTile,
  preferDeliveryTile,
  setDeliveryMultiplier,
  removeDeliveryTileRule,
  clearPersistentRules,
  blockTile,
  unblockTile,
} from "./tools.js";

// ==========================================
// Tool execution
// ==========================================

/*
 * Executes the atomic action chosen by the model and returns the observation.
 * action = { name: string, params: object }
 */
async function executeTool(action, bs, llmState, actions) {
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
        const deliveredCount = [...bs.parcels.values()].filter(
          (parcel) => parcel.carriedBy === bs.me.id
        ).length;

        await actions.goDropOff(params.x, params.y);

        return `Delivered ${deliveredCount} parcel(s) at (${params.x}, ${params.y}).`;
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
      return get_environment_state(bs, llmState);

    case "set_stack_size":
      return setStackSize(params, bs, llmState);

    case "remove_stack_size":
      return removeStackSize(params, bs, llmState);

    case "set_parcel_filter":
      return setParcelFilter(params, bs, llmState);

    case "remove_parcel_filter":
      return removeParcelFilter(params, bs, llmState);

    case "forbid_delivery_tile":
      return forbidDeliveryTile(params, bs, llmState);

    case "prefer_delivery_tile":
      return preferDeliveryTile(params, bs, llmState);

    case "set_delivery_multiplier":
      return setDeliveryMultiplier(params, bs, llmState);

    case "remove_delivery_tile_rule":
      return removeDeliveryTileRule(params, bs, llmState);

    case "clear_persistent_rules":
      return clearPersistentRules(params, bs, llmState);

    case "block_tile":
      return blockTile(params, bs, llmState);

    case "unblock_tile":
      return unblockTile(params, bs, llmState);

    default:
      return `Unknown action: ${name}.`;
  }
}

// ==========================================
// Entry point
// ==========================================

/*
 * Saves the history of completed missions, keeping only the last N.
 */
function saveMissionHistory(llmState, { request, reply }) {
  if (!Array.isArray(llmState.missionHistory)) {
    llmState.missionHistory = [];
  }

  llmState.missionHistory.push({
    request,
    reply,
    completedAt: Date.now(), 
  });

  if (llmState.missionHistory.length > MAX_MISSION_HISTORY) {
    llmState.missionHistory.shift();
  }
}

/*
 * Starts the special-mission listener via chat.
 * For each received message it runs the ReAct loop maintaining
 * a real conversation history (assistant + tool roles),
 * until the model produces final_reply.
 */
export async function startLLMAgent(socket, bs, llmState, actions) {
  console.log(`[${bs.me.name ?? "LLM"}]`, "LLM chat listener started");

  socket.onMsg(async (id, name, msg) => {
    if (!msg || msg.trim() === "") return;
    if (id === bs.me.id) return;

    console.log(`[${bs.me.name ?? "LLM"}]`, `Mission from ${name} (${id}): ${msg}`);

    // Real conversation history: grows on each iteration.
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildMissionUserPrompt(msg, llmState.persistentMemory, llmState.missionHistory) },
    ];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const { action, toolCall } = await callLLMTool({
          messages,
          tools: MISSION_TOOLS,
          temperature: 0,
        });

        console.log(`[${bs.me.name ?? "LLM"}]`, `Action: ${action.name}(${JSON.stringify(action.params)})`);

        // Save the assistant's call in the history in the native format.
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        });

        if (action.name === "final_reply") {
          await socket.emitSay(id, action.params.message);

          saveMissionHistory(llmState, {
            request: msg,
            reply: action.params.message,
          });

          break;
        }

        const validationError = validateActionAgainstPersistentRules(
          action,
          bs,
          llmState
        );

        if (validationError) {
          const observation = `Action rejected by persistent rules: ${validationError}`;

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: observation,
          });

          continue;
        }
        
        const observation = await executeTool(action, bs, llmState, actions);
        console.log(`[${bs.me.name ?? "LLM"}]`, "Observation:", observation);

        // Save the tool result in the history under the "tool" role.
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: observation,
        });
      }
    } catch (error) {
      console.log(`[${bs.me.name ?? "LLM"}]`, "Mission error:", error?.message ?? error);
      try {
        await socket.emitSay(id, "Sorry, I could not complete the mission.");
      } catch {}
    }
  });
}