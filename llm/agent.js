import { callLLMTool } from "./client.js";
import {
  MAX_ITERATIONS,
  BDI_DELEGATION_POLL_MS,
  BDI_DELEGATION_PER_PARCEL_MS,
  BDI_DELEGATION_DEFAULT_MS,
} from "../utils/constants.js";
import { waitUntil } from "../utils/asyncUtils.js";
import { validateActionAgainstPersistentRules } from "./rulesValidator.js";
import {
  SYSTEM_EXECUTOR_PROMPT,
  SYSTEM_EXECUTOR_TOOLS,
  buildMissionUserPrompt,
  mapExecutorAction,
} from "./prompts/index.js";
import { createSessionLogger } from "./historyLogger.js";
import { LLM_CONFIG } from "../config.js";

import {
  calculate,
  findDeliveryTile,
  get_environment_state,
  setStackSize,
  removeStackSize,
  setParcelValueRule,
  removeParcelValueRule,
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
import { startAutonomousBDI } from "../bdi/bdiAgent.js";
import { isCoordMessage } from "../utils/coordProtocol.js";

// ==========================================
// Rule-tool detection (for history logging)
// ==========================================

const RULE_TOOL_NAMES = new Set([
  "set_stack_size",
  "remove_stack_size",
  "set_parcel_value_rule",
  "remove_parcel_value_rule",
  "forbid_delivery_tile",
  "prefer_delivery_tile",
  "set_delivery_multiplier",
  "remove_delivery_tile_rule",
  "clear_persistent_rules",
  "block_tile",
  "unblock_tile",
]);

// Tools that, on success, fully complete a mission on their own — storing a
// durable rule (or a navigation constraint) IS the whole task per the executor
// contract (RULE missions are classified as such and never combined with a
// TASK). Treating them as terminal lets the loop end the mission immediately,
// using the tool's own confirmation as the chat reply, instead of paying a
// second full LLM round-trip just to emit final_reply. The rule set above
// already enumerates exactly these store-tools, so it doubles as the terminal
// set; collect_and_deliver signals terminality per-call via toolResult.terminal.
const TERMINAL_TOOL_NAMES = RULE_TOOL_NAMES;

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

async function executeTool(action, bs, llmState, actions, missionStats, coordinator, bdi) {
  const { name, params } = action;

  switch (name) {
    case "collect_and_deliver": {
      // Hand the whole pick-up/deliver play loop to the embedded autonomous BDI
      // instead of micro-driving it one LLM round-trip per move. The BDI already
      // scores and harvests parcels locally with zero model calls; here we just
      // un-pause it for a bounded window, watch the shared delivery counter, then
      // re-pause it. One LLM call starts the whole task; this tool is terminal,
      // so the mission ends without a second round-trip.
      const target =
        Number.isInteger(params.parcels) && params.parcels > 0
          ? params.parcels
          : null;
      const timeoutMs =
        Number.isInteger(params.timeoutMs) && params.timeoutMs > 0
          ? params.timeoutMs
          : target
            ? target * BDI_DELEGATION_PER_PARCEL_MS
            : BDI_DELEGATION_DEFAULT_MS;

      const start = bs.metrics?.deliveredParcels ?? 0;
      const startedAt = Date.now();

      bdi.resume();
      try {
        await waitUntil(() => {
          const delivered = (bs.metrics?.deliveredParcels ?? 0) - start;
          if (target != null && delivered >= target) return true;
          return Date.now() - startedAt > timeoutMs;
        }, BDI_DELEGATION_POLL_MS);
      } finally {
        // Always re-pause: the mission loop owns the BDI's paused state while a
        // chat mission is being handled, and resumes it for good in its finally.
        bdi.pause();
      }

      const delivered = (bs.metrics?.deliveredParcels ?? 0) - start;
      const reason =
        target != null && delivered >= target
          ? "target reached"
          : "time budget elapsed";

      // Terminal-only: the delivered count is already in the observation and the
      // reply. Do NOT set deliverySucceeded here — the loop's delivery logger keys
      // off action.params.x/y, which this tool does not carry.
      return makeToolResult(
        `Delivered ${delivered} parcel(s) via autonomous collection (${reason}).`,
        { terminal: true }
      );
    }

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

    case "rendezvous_with_partner": {
      // FENT-style single barrier: send go_near to partner, move self in
      // parallel, wait for both arrivals, release partner. One atomic tool
      // call eliminates the multi-step confusion that caused the LLM to add
      // a spurious direct_partner("wait") after the barrier.
      const { cid, delivered } = await coordinator.directPartner("go_near", {
        x: params.x,
        y: params.y,
        maxDist: params.maxDist,
      });

      let selfMsg;
      try {
        await actions.goNear(params.x, params.y, params.maxDist);
        selfMsg = "self arrived";
      } catch (err) {
        selfMsg = `self could not reach: ${err?.message ?? err}`;
      }

      const partnerStatus = delivered
        ? await coordinator.waitForPartner(cid)
        : { cid, ok: false, detail: "teammate not reachable" };

      try { await coordinator.directPartner("resume"); } catch {}

      return makeToolResult(
        partnerStatus.ok
          ? `Rendezvous complete: both agents within ${params.maxDist} tiles of (${params.x},${params.y}) (${selfMsg}).`
          : `Rendezvous incomplete — teammate: ${partnerStatus.detail ?? "failed"}; ${selfMsg}.`
      );
    }

    case "calculate":
      return makeToolResult(calculate(params));

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

    case "get_environment_state":
      return makeToolResult(get_environment_state(bs, llmState, missionStats));

    case "set_stack_size":
      return makeToolResult(setStackSize(params, bs));

    case "remove_stack_size":
      return makeToolResult(removeStackSize(params, bs));

    case "set_parcel_value_rule":
      return makeToolResult(setParcelValueRule(params, bs));

    case "remove_parcel_value_rule":
      return makeToolResult(removeParcelValueRule(params, bs));

    case "forbid_delivery_tile":
      return makeToolResult(forbidDeliveryTile(params, bs));

    case "prefer_delivery_tile":
      return makeToolResult(preferDeliveryTile(params, bs));

    case "set_delivery_multiplier":
      return makeToolResult(setDeliveryMultiplier(params, bs));

    case "remove_delivery_tile_rule":
      return makeToolResult(removeDeliveryTileRule(params, bs));

    case "clear_persistent_rules":
      return makeToolResult(clearPersistentRules(params, bs));

    case "block_tile":
      return makeToolResult(blockTile(params, bs));

    case "unblock_tile":
      return makeToolResult(unblockTile(params, bs));

    default:
      return makeToolResult(`Unknown action: ${name}.`);
  }
}

// ==========================================
// Mission validator
// ==========================================

// ==========================================
// Mission queue
// ==========================================

/*
 * Serialises all incoming chat missions so they never run concurrently.
 * Without this, two rapid messages would both pause/resume the BDI loop
 * and race over the same parcels, causing cascading pickup rejections and
 * delivering to the wrong tile.
 */
function createMissionQueue(logFn) {
  const queue = [];
  let running = false;

  async function drain() {
    running = true;
    while (queue.length > 0) {
      const { task, label } = queue.shift();
      if (queue.length > 0) {
        logFn(`Queue: executing "${label}" (${queue.length} mission(s) waiting)`);
      }
      await task();
    }
    running = false;
  }

  return {
    enqueue(label, task) {
      if (running) {
        logFn(`Queue: "${label}" enqueued (1 mission already running)`);
      }
      queue.push({ task, label });
      if (!running) drain();
    },
  };
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

  // Whenever the LLM adds or drops a rule, push the full ruleset to the
  // BDI-only partner so it stays in sync. Fired from refreshRendered (the one
  // choke point every rule change passes through). Fire-and-forget; no-op
  // without a partner.
  bs.rules.onChange = () => {
    coordinator.syncRules().catch(() => {});
  };

  const logger = createSessionLogger({
    maxIterations: MAX_ITERATIONS,
    model: LLM_CONFIG?.model,
  });

  logWithTime(bs.me.name, `Session logging → ${logger.sessionDir}`);

  // By default the LLM-controlled agent behaves as an autonomous BDI: it scores
  // and harvests parcels on its own. An incoming chat message pauses this loop
  // (see onMsg below), the message is interpreted, then the loop resumes. This
  // is the agent's own embedded loop — separate from any partner BDI it directs
  // over the wire in MULTI mode. (logger must be created first: it is passed in
  // here and a const cannot be read before its declaration.)
  const bdi = startAutonomousBDI(bs, actions, logger);

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

  const missionQueue = createMissionQueue((...args) => logWithTime(bs.me.name, ...args));

  socket.onMsg(async (id, name, msg) => {
    if (isCoordMessage(msg)) {
      if (msg.type === "status") coordinator.handleStatus(msg);
      return;
    }
    if (!msg || typeof msg !== "string" || msg.trim() === "") return;
    if (id === bs.me.id) return;

    logWithTime(bs.me.name, `Mission from ${name} (${id}): ${msg}`);

    missionQueue.enqueue(msg.slice(0, 60), async () => {

    let missionId = null;

    try {
      // Stop autonomous BDI behavior so it does not drive the agent while the
      // message is interpreted; resumed in finally. pause() preempts the
      // running intention (re-queued, not failed) well before the executor
      // issues any movement.
      bdi.pause();

      missionId = logger.startMission(msg, bs.rules.rendered ?? "None.");

      const messages = [
        { role: "system", content: SYSTEM_EXECUTOR_PROMPT },
        {
          role: "user",
          content: buildMissionUserPrompt(
            msg,
            bs.rules.rendered,
            buildValidatorSnapshot(bs, llmState)
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

        const { thought = null, more = false, ...actionParams } = rawAction.params ?? {};

        // `more` is a control-flow flag, not a tool parameter: the model sets it
        // when a compound mission still has a further clause to handle after this
        // tool. Strip it (like thought) so it never reaches the tool functions or
        // the rule-change log. Tolerate the model emitting it as a JSON string.
        const moreToDo = more === true || more === "true";

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

          logger.endMission(missionId, "completed", finalReply, bs.rules.rendered ?? "None.");
          completed = true;
          break;
        }

        const validationError = validateActionAgainstPersistentRules(
          action,
          bs
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
          coordinator,
          bdi
        );
        const observation = toolResult.observation;

        if (toolResult.deliverySucceeded) {
          if (missionStats === null) {
            missionStats = { deliveries: toolResult.deliveredCount };
          } else {
            missionStats.deliveries += toolResult.deliveredCount;
          }
          logger.logDelivery(
            missionId,
            action.params.x,
            action.params.y,
            toolResult.deliveredCount
          );
        }

        if (RULE_TOOL_NAMES.has(action.name)) {
          logger.logRuleChange(
            missionId,
            action.name,
            action.params,
            bs.rules.rendered ?? "None."
          );
        }

        logWithTime(bs.me.name, "Observation:", observation);
        logger.logObservation(missionId, action.name, observation);

        // Terminal tools complete the mission on their own (durable-rule /
        // navigation stores, and the BDI-delegated play loop). End here using
        // the tool's own confirmation as the reply, skipping the extra LLM
        // round-trip that a separate final_reply would cost. Three things defeat
        // terminality: an errored tool (feed the error back so the model
        // retries), and `more: true` — the model's signal that this is a
        // compound mission with another clause still to handle, so the loop must
        // continue instead of ending after the first rule (otherwise compound
        // "do X AND do Y" missions would silently drop their second clause).
        const toolErrored =
          typeof observation === "string" && observation.startsWith("Error:");
        const isTerminal =
          (TERMINAL_TOOL_NAMES.has(action.name) || toolResult.terminal === true) &&
          !toolErrored &&
          !moreToDo;

        if (isTerminal) {
          finalReply = observation.split("\n")[0];

          logger.logFinalReply(missionId, finalReply);
          await socket.emitSay(id, finalReply);

          logger.endMission(missionId, "completed", finalReply, bs.rules.rendered ?? "None.");
          completed = true;
          break;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: observation,
        });
      }

      if (!completed) {
        finalReply = "Mission failed: maximum number of execution steps reached.";

        await socket.emitSay(id, finalReply);

        logger.endMission(missionId, "failed", finalReply, bs.rules.rendered ?? "None.");
      }
    } catch (error) {
      const errorMessage = error?.message ?? String(error);

      logWithTime(bs.me.name, "Mission error:", errorMessage);

      if (missionId) {
        logger.endMission(missionId, "failed", errorMessage, bs.rules.rendered ?? "None.");
      }

      try {
        await socket.emitSay(id, "Sorry, I could not complete the mission.");
      } catch {}
    } finally {
      // Never leave the partner BDI stuck in directive mode if this mission
      // engaged it — UNLESS the partner is intentionally parked waiting for an
      // external signal (partnerParkedOn is set). In that case, the next mission
      // turn will relay the signal and then send resume; sending it now would
      // prematurely release a wait that hasn't been answered yet.
      if (llmState.coordination.active && !llmState.coordination.partnerParkedOn) {
        try {
          await coordinator.directPartner("resume");
        } catch {}
      }

      // Resume this agent's own autonomous BDI loop.
      bdi.resume();
    }

    }); // end missionQueue.enqueue
  });
}