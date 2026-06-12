import { callLLMTool } from "./client.js";
import { MAX_ITERATIONS, MAX_MISSION_HISTORY } from "../utils/constants.js";
import { validateActionAgainstPersistentRules } from "./rulesValidator.js";
import {
  SYSTEM_VALIDATOR_PROMPT,
  SYSTEM_VALIDATOR_TOOLS,
  SYSTEM_EXECUTOR_PROMPT,
  SYSTEM_EXECUTOR_TOOLS,
  buildValidatorUserPrompt,
  buildMissionUserPrompt,
  mapExecutorAction,
} from "./prompts/index.js";
import { createSessionLogger } from "./historyLogger.js";
import { LLM_CONFIG } from "../config.js";

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
        return `Could not reach (${params.x}, ${params.y}): ${error?.message ?? error}.`;
      }
    }

    case "go_pick_up": {
      try {
        await actions.goPickUp(params.x, params.y, params.parcelId);
        return `Picked up parcel ${params.parcelId} at (${params.x}, ${params.y}).`;
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
// Mission history
// ==========================================

function saveMissionHistory(llmState, { request, reply }) {
  if (!Array.isArray(llmState.missionHistory)) {
    llmState.missionHistory = [];
  }

  llmState.missionHistory.push({
    request,
    reply,
    completedAt: Date.now(),
  });

  while (llmState.missionHistory.length > MAX_MISSION_HISTORY) {
    llmState.missionHistory.shift();
  }
}

// ==========================================
// Mission validator
// ==========================================

async function validateMission(msg, llmState) {
  const { action } = await callLLMTool({
    messages: [
      { role: "system", content: SYSTEM_VALIDATOR_PROMPT },
      {
        role: "user",
        content: buildValidatorUserPrompt(
          msg,
          llmState.persistentMemory
        ),
      },
    ],
    tools: SYSTEM_VALIDATOR_TOOLS,
    temperature: 0,
  });

  return action.params;
}

// ==========================================
// Entry point
// ==========================================

export async function startLLMAgent(socket, bs, llmState, actions) {
  logWithTime(bs.me.name, "LLM chat listener started");

  const logger = createSessionLogger({
    maxIterations,
    maxMissionHistory: MAX_MISSION_HISTORY,
    model: LLM_CONFIG?.model,
  });

  logWithTime(bs.me.name, `Session logging → ${logger.sessionDir}`);

  // Flush on exit so the last summary is always written
  const onExit = () => logger.endSession();
  process.once("exit",    onExit);
  process.once("SIGINT",  () => { onExit(); process.exit(0); });
  process.once("SIGTERM", () => { onExit(); process.exit(0); });

  socket.onMsg(async (id, name, msg) => {
    if (!msg || msg.trim() === "") return;
    if (id === bs.me.id) return;

    logWithTime(bs.me.name, `Mission from ${name} (${id}): ${msg}`);

    try {
      const missionId = logger.startMission(msg);

      const validation = await validateMission(msg, llmState);

      if (validation.thought) {
        logWithTime(bs.me.name, `Validator thought: ${validation.thought}`);
      }

      logWithTime(
        bs.me.name,
        `Validator decision: accepted=${validation.accepted}, reason=${validation.reason}`
      );

      logger.logValidatorDecision(missionId, validation);

      if (!validation.accepted) {
        await socket.emitSay(id, validation.reason);

        saveMissionHistory(llmState, {
          request: msg,
          reply: validation.reason,
        });

        logger.endMission(missionId, "rejected", validation.reason);
        return;
      }

      const messages = [
        { role: "system", content: SYSTEM_EXECUTOR_PROMPT },
        {
          role: "user",
          content: buildMissionUserPrompt(
            msg,
            llmState.persistentMemory,
            llmState.missionHistory
          ),
        },
      ];

      let completed = false;
      let finalReply = null;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const { action: rawAction, toolCall } = await callLLMTool({
          messages,
          tools: SYSTEM_EXECUTOR_TOOLS,
          temperature: 0,
        });

        const action = mapExecutorAction(rawAction);

        const { thought, ...actionParams } = rawAction.params;
        if (thought) logWithTime(bs.me.name, `Thought: ${thought}`);

        logWithTime(
          bs.me.name,
          `Action: ${rawAction.name}(${JSON.stringify(actionParams)})`
        );

        logger.logExecutorAction(missionId, {
          rawName:    rawAction.name,
          mappedName: action.name,
          params:     actionParams,
          thought:    thought ?? null,
        });

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        });

        if (action.name === "final_reply") {
          finalReply = action.params.message;
          logger.logFinalReply(missionId, finalReply);
          await socket.emitSay(id, finalReply);

          saveMissionHistory(llmState, {
            request: msg,
            reply: finalReply,
          });

          logger.endMission(missionId, "completed", finalReply);
          completed = true;
          break;
        }

        const validationError = validateActionAgainstPersistentRules(
          action,
          bs,
          llmState
        );

        if (validationError) {
          const observation = `Action rejected by persistent rules: ${validationError}`;
          logger.logActionRejected(missionId, action.name, validationError);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: observation,
          });

          continue;
        }

        const observation = await executeTool(action, bs, llmState, actions);
        logWithTime(bs.me.name, "Observation:", observation);
        logger.logObservation(missionId, action.name, observation);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: observation,
        });
      }

      if (!completed) {
        finalReply = "Mission failed: maximum number of execution steps reached.";

        await socket.emitSay(id, finalReply);

        saveMissionHistory(llmState, {
          request: msg,
          reply: finalReply,
        });

        logger.endMission(missionId, "failed", finalReply);
      }
    } catch (error) {
      logWithTime(bs.me.name, "Mission error:", error?.message ?? error);
      logger.endMission(missionId, "failed", error?.message ?? String(error));

      try {
        await socket.emitSay(id, "Sorry, I could not complete the mission.");
      } catch {}
    }
  });
}