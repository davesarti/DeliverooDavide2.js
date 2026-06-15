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
  buildValidatorSnapshot,
} from "./tools.js";
import { createCoordinator } from "./coordinator.js";
import { isCoordMessage } from "../utils/coordProtocol.js";

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
// Tool execution helpers
// ==========================================

function makeToolResult(observation, extra = {}) {
  return {
    observation,
    ...extra,
  };
}

// ==========================================
// Tool execution
// ==========================================

async function executeTool(action, bs, llmState, actions, missionStats, coordinator) {
  const { name, params } = action;

  switch (name) {
    case "direct_partner": {
      const { command, x, y, maxDist, parcelId, signal, timeoutMs } = params;
      const args = {};
      if (command === "go_to") {
        args.x = x;
        args.y = y;
      } else if (command === "go_near") {
        args.x = x;
        args.y = y;
        args.maxDist = maxDist;
      } else if (command === "pickup") {
        args.x = x;
        args.y = y;
        args.parcelId = parcelId;
      } else if (command === "putdown") {
        args.x = x;
        args.y = y;
      } else if (command === "wait") {
        args.signal = signal;
        if (timeoutMs != null) args.timeoutMs = timeoutMs;
      }

      const { cid, delivered } = await coordinator.directPartner(command, args);
      return makeToolResult(
        delivered
          ? `Directive '${command}' sent to teammate (cid=${cid}). Call wait_for_partner with cid=${cid} to await the result.`
          : `Could not reach teammate to send '${command}' (cid=${cid}). The partner may be offline.`
      );
    }

    case "signal_partner": {
      const { delivered } = await coordinator.signalPartner(params.signal);
      return makeToolResult(
        delivered
          ? `Signal '${params.signal}' sent to teammate.`
          : `Could not reach teammate to send signal '${params.signal}'.`
      );
    }

    case "wait_for_partner": {
      const status = await coordinator.waitForPartner(params.cid, params.timeoutMs);
      return makeToolResult(
        status.ok
          ? `Teammate completed directive cid=${status.cid}${status.detail ? `: ${status.detail}` : "."}`
          : `Teammate directive cid=${status.cid} did not complete: ${status.detail ?? "unknown reason"}.`
      );
    }

    case "calculate":
      return makeToolResult(calculate(params));

    case "get_my_position":
      return makeToolResult(getMyPosition(bs));

    case "find_delivery_tile":
      return makeToolResult(findDeliveryTile(params, bs));

    case "go_to": {
      try {
        await actions.goTo(params.x, params.y);
        return makeToolResult(`Arrived at (${params.x}, ${params.y}).`);
      } catch (error) {
        return makeToolResult(
          `Could not reach (${params.x}, ${params.y}): ${error?.message ?? error}.`
        );
      }
    }

    case "go_pick_up": {
      try {
        await actions.goPickUp(params.x, params.y, params.parcelId);
        return makeToolResult(
          `Picked up parcel ${params.parcelId} at (${params.x}, ${params.y}).`
        );
      } catch (error) {
        return makeToolResult(
          `Could not pick up at (${params.x}, ${params.y}): ${error?.message ?? error}.`
        );
      }
    }

    case "go_drop_off": {
      try {
        const deliveredCount = [...bs.parcels.values()].filter(
          (parcel) => parcel.carriedBy === bs.me.id
        ).length;

        await actions.goDropOff(params.x, params.y);

        return makeToolResult(
          `Delivered ${deliveredCount} parcel(s) at (${params.x}, ${params.y}).`,
          {
            deliverySucceeded: true,
            deliveredCount,
          }
        );
      } catch (error) {
        return makeToolResult(
          `Could not deliver at (${params.x}, ${params.y}): ${error?.message ?? error}.`,
          {
            deliverySucceeded: false,
            deliveredCount: 0,
          }
        );
      }
    }

    case "explore": {
      try {
        await actions.explore();
        return makeToolResult("Exploration complete.");
      } catch (error) {
        return makeToolResult(`Could not explore: ${error?.message ?? error}.`);
      }
    }

    case "get_environment_state":
      return makeToolResult(get_environment_state(bs, llmState, missionStats));

    case "set_stack_size":
      return makeToolResult(setStackSize(params, bs, llmState));

    case "remove_stack_size":
      return makeToolResult(removeStackSize(params, bs, llmState));

    case "set_parcel_filter":
      return makeToolResult(setParcelFilter(params, bs, llmState));

    case "remove_parcel_filter":
      return makeToolResult(removeParcelFilter(params, bs, llmState));

    case "forbid_delivery_tile":
      return makeToolResult(forbidDeliveryTile(params, bs, llmState));

    case "prefer_delivery_tile":
      return makeToolResult(preferDeliveryTile(params, bs, llmState));

    case "set_delivery_multiplier":
      return makeToolResult(setDeliveryMultiplier(params, bs, llmState));

    case "remove_delivery_tile_rule":
      return makeToolResult(removeDeliveryTileRule(params, bs, llmState));

    case "clear_persistent_rules":
      return makeToolResult(clearPersistentRules(params, bs, llmState));

    case "block_tile":
      return makeToolResult(blockTile(params, bs, llmState));

    case "unblock_tile":
      return makeToolResult(unblockTile(params, bs, llmState));

    default:
      return makeToolResult(`Unknown action: ${name}.`);
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

async function validateMission(msg, bs, llmState) {
  const { action } = await callLLMTool({
    messages: [
      { role: "system", content: SYSTEM_VALIDATOR_PROMPT },
      {
        role: "user",
        content: buildValidatorUserPrompt(
          msg,
          llmState.persistentMemory,
          buildValidatorSnapshot(bs, llmState)
        ),
      },
    ],
    tools: SYSTEM_VALIDATOR_TOOLS,
    temperature: 0,
  });

  return action.params;
}

// ==========================================
// Thought stripping
// ==========================================

function stripThought(action) {
  if (!action?.params) return { action, thought: null };

  const { thought = null, ...params } = action.params;

  return {
    thought,
    action: {
      ...action,
      params,
    },
  };
}

// ==========================================
// Entry point
// ==========================================

export async function startLLMAgent(socket, bs, llmState, actions) {
  logWithTime(bs.me.name, "LLM chat listener started");

  const coordinator = createCoordinator(socket, bs, llmState);

  const logger = createSessionLogger({
    maxIterations: MAX_ITERATIONS,
    maxMissionHistory: MAX_MISSION_HISTORY,
    model: LLM_CONFIG?.model,
  });

  logWithTime(bs.me.name, `Session logging → ${logger.sessionDir}`);

  const onExit = () => logger.endSession();
  process.once("exit", onExit);
  process.once("SIGINT", () => {
    onExit();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    onExit();
    process.exit(0);
  });

  socket.onMsg(async (id, name, msg) => {
    if (isCoordMessage(msg)) {
      if (msg.type === "status") coordinator.handleStatus(msg);
      return;
    }
    if (!msg || typeof msg !== "string" || msg.trim() === "") return;
    if (id === bs.me.id) return;

    logWithTime(bs.me.name, `Mission from ${name} (${id}): ${msg}`);

    let missionId = null;

    try {
      missionId = logger.startMission(msg);

      const validation = await validateMission(msg, bs, llmState);

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
      let missionStats = null;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const { action: rawAction, toolCall } = await callLLMTool({
          messages,
          tools: SYSTEM_EXECUTOR_TOOLS,
          temperature: 0,
        });

        const { thought = null, ...actionParams } = rawAction.params ?? {};

        const cleanRawAction = {
          ...rawAction,
          params: actionParams,
        };

        const action = mapExecutorAction(cleanRawAction);

        logWithTime(
          bs.me.name,
          `Action: ${rawAction.name}(${JSON.stringify(actionParams)})`
        );

        logger.logExecutorAction(missionId, {
          rawName: rawAction.name,
          mappedName: action.name,
          params: actionParams,
          thought,
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

        const toolResult = await executeTool(
          action,
          bs,
          llmState,
          actions,
          missionStats,
          coordinator
        );
        const observation = toolResult.observation;

        if (toolResult.deliverySucceeded) {
          if (missionStats === null) {
            missionStats = { deliveries: toolResult.deliveredCount };
          } else {
            missionStats.deliveries += toolResult.deliveredCount;
          }
        }

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
      const errorMessage = error?.message ?? String(error);

      logWithTime(bs.me.name, "Mission error:", errorMessage);

      if (missionId) {
        logger.endMission(missionId, "failed", errorMessage);
      }

      try {
        await socket.emitSay(id, "Sorry, I could not complete the mission.");
      } catch {}
    } finally {
      // Never leave the BDI stuck in directive mode if this mission engaged it.
      if (llmState.coordination.active) {
        try {
          await coordinator.directPartner("resume");
        } catch {}
      }
    }
  });
}