import { callLLMTool } from "./client.js";
import {
  MAX_ITERATIONS,
  BDI_DELEGATION_POLL_MS,
  BDI_DELEGATION_PER_PARCEL_MS,
  BDI_DELEGATION_DEFAULT_MS,
  BDI_DELEGATION_MAX_MS,
  RENDEZVOUS_SELF_ATTEMPTS,
  RENDEZVOUS_SELF_RETRY_DELAY_MS,
  HANDOFF_MAX_PICKUPS,
} from "../utils/constants.js";
import { waitUntil, wait } from "../utils/asyncUtils.js";
import { nearestDeliveryTileAt } from "../utils/stateUtils.js";
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
  clearNavigationRules,
  buildValidatorSnapshot,
  validateTile,
  validateDeliveryTile,
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
  "clear_navigation_rules",
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

// Tools that take exclusive control of THIS agent so the autonomous BDI loop is
// paused (once, lazily) the first time one is about to execute: the "direct
// mission" self-task tools (movement / collect_and_deliver), rendezvous (which
// walks self via goNear), and wait_for_partner — the agent must hold still
// awaiting the teammate, not wander off mid-coordination. Everything else keeps
// the loop harvesting while the LLM elaborates: rule/query tools only read state
// or store a rule, and direct_partner / signal_partner only command or signal
// the TEAMMATE without committing this agent. The one remaining freeze case — a
// red-light `wait` directive that parks the partner — is handled separately, off
// partnerParkedOn, below. Names are the mapped (post-mapExecutorAction) tool
// names the executor switch dispatches on.
const BDI_PAUSING_TOOLS = new Set([
  "collect_and_deliver",
  "go_to",
  "go_pick_up",
  "go_drop_off",
  "rendezvous_with_partner",
  "handoff_to_partner",
  "wait_for_partner",
]);

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

async function executeTool(action, bs, llmState, actions, missionStats, coordinator, bdi, moreToDo = false) {
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
      const requestedTimeoutMs =
        Number.isInteger(params.timeoutMs) && params.timeoutMs > 0
          ? params.timeoutMs
          : target
            ? target * BDI_DELEGATION_PER_PARCEL_MS
            : BDI_DELEGATION_DEFAULT_MS;
      // Never trust an LLM-supplied (or count-derived) budget to be sane: cap it
      // so one mission can never strand the agent for the whole match.
      const timeoutMs = Math.min(requestedTimeoutMs, BDI_DELEGATION_MAX_MS);

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

      const ALLOWED_COMMANDS = new Set([
        "go_to", "go_near", "pickup", "putdown", "wait", "resume",
      ]);
      if (!ALLOWED_COMMANDS.has(command)) {
        return makeToolResult(
          `Error: unknown partner command "${command}". Allowed: go_to, go_near, pickup, putdown, wait, resume.`
        );
      }
      // A pickup with no coordinates is the self-directed handoff form: the
      // teammate grabs the nearest parcel IT can sense (the LLM can't see the
      // partner's surroundings). This matches the BDI's args.x == null branch in
      // #runCoordination, the tool schema, and the executor prompt. Targeted
      // pickup (x, y + parcelId) is still validated below.
      const selfDirectedPickup =
        command === "pickup" && x == null && y == null;

      const needsCoords =
        command === "go_to" || command === "go_near" ||
        (command === "pickup" && !selfDirectedPickup) || command === "putdown";
      if (needsCoords) {
        const tileError = validateTile(x, y, bs);
        if (tileError) {
          return makeToolResult(`Error: '${command}' needs valid map coordinates — ${tileError}`);
        }
      }
      if (command === "go_near" && !(Number.isInteger(maxDist) && maxDist >= 0)) {
        return makeToolResult(
          `Error: 'go_near' needs a non-negative integer maxDist, received ${maxDist}.`
        );
      }
      if (command === "pickup" && !selfDirectedPickup && (parcelId == null || parcelId === "")) {
        return makeToolResult("Error: targeted 'pickup' needs a parcelId (or omit x,y to let the teammate self-select).");
      }
      if (command === "wait" && (typeof signal !== "string" || signal.trim() === "")) {
        return makeToolResult("Error: 'wait' needs a signal label.");
      }

      const args = {};
      if (command === "go_to") {
        args.x = x;
        args.y = y;
      } else if (command === "go_near") {
        args.x = x;
        args.y = y;
        args.maxDist = maxDist;
      } else if (command === "pickup") {
        // Self-directed pickup leaves args empty so the BDI partner self-selects
        // (args.x == null branch). Targeted pickup carries the tile + parcel id.
        if (!selfDirectedPickup) {
          args.x = x;
          args.y = y;
          args.parcelId = parcelId;
        }
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
      // parallel, wait for both arrivals, then release the partner (unless
      // more=true, in which case the next directive is issued first to prevent
      // the partner drifting away before the wait lands).
      const { cid, delivered } = await coordinator.directPartner("go_near", {
        x: params.x,
        y: params.y,
        maxDist: params.maxDist,
      });

      // Move self in parallel. The first sweep can fail when the partner is
      // still crossing the small target neighbourhood and transiently blocks the
      // only reachable tile; retry, since the partner parks on arrival and the
      // contested tile then clears.
      let selfArrived = false;
      let selfMsg = "self could not reach";
      for (let attempt = 0; attempt < RENDEZVOUS_SELF_ATTEMPTS; attempt++) {
        try {
          await actions.goNear(params.x, params.y, params.maxDist);
          selfArrived = true;
          selfMsg = "self arrived";
          break;
        } catch (err) {
          selfMsg = `self could not reach: ${err?.message ?? err}`;
          if (attempt < RENDEZVOUS_SELF_ATTEMPTS - 1) {
            await wait(RENDEZVOUS_SELF_RETRY_DELAY_MS);
          }
        }
      }

      const partnerStatus = delivered
        ? await coordinator.waitForPartner(cid)
        : { cid, ok: false, detail: "teammate not reachable" };

      // Only release the partner now if no further directive follows immediately.
      // When more=true the LLM will issue the next command (e.g. direct_partner
      // "wait") before handing back control, so keep the partner in coordination
      // mode (empty queue, active=true) to close the gap that let it drift away.
      if (!moreToDo) {
        try { await coordinator.directPartner("resume"); } catch {}
      }

      // The barrier is met only when BOTH agents actually arrived. Keying the
      // verdict on the partner alone wrongly reported "complete" while self was
      // still stranded — a false success the LLM then relayed to the operator.
      //
      // Terminal: rendezvous is one atomic action that fully accomplishes "make
      // both agents meet", so the observation IS the chat reply. Ending here
      // (unless the model flags a further clause with more=true) skips a second
      // full LLM round-trip just to emit final_reply — the long idle the operator
      // sees after the agents have already met. Same pattern as collect_and_deliver.
      if (selfArrived && partnerStatus.ok) {
        return makeToolResult(
          `Rendezvous complete: both agents within ${params.maxDist} tiles of (${params.x},${params.y}).`,
          { terminal: true }
        );
      }
      const partnerMsg = partnerStatus.ok
        ? "teammate arrived"
        : `teammate: ${partnerStatus.detail ?? "failed"}`;
      return makeToolResult(
        `Rendezvous incomplete — ${selfMsg}; ${partnerMsg}.`,
        { terminal: true }
      );
    }

    case "handoff_to_partner": {
      // Atomic Level-3 handoff: the BDI teammate collects parcel(s) from its OWN
      // surroundings, drops the whole load on its OWN tile, vacates, then this
      // agent walks onto that tile, grabs everything, and (by default) delivers.
      // One tool call replaces the error-prone direct_partner + putdown + pick_up
      // + deliver choreography the model kept fumbling: drop-at-feet guarantees a
      // tile the carrier can reach and that is NEVER this agent's own cell (the
      // collision that produced "path not found" in the manual flow). Supports an
      // arbitrary number of parcels — the teammate stacks repeated self-directed
      // pickups and a single putdown drops the whole stack at once.
      const target =
        Number.isInteger(params.parcels) && params.parcels > 0
          ? Math.min(params.parcels, HANDOFF_MAX_PICKUPS)
          : null;
      const shouldDeliver = params.deliver !== false;

      // 1) Teammate harvests. Self-directed pickups stack on its carry; stop when
      // the target is met, nothing more is reachable, or the safety cap is hit.
      let collected = 0;
      let partnerHasLoad = false;
      let partnerReachable = true;
      const cap = target ?? HANDOFF_MAX_PICKUPS;
      for (let i = 0; i < cap; i++) {
        const { cid, delivered } = await coordinator.directPartner("pickup", {});
        if (!delivered) {
          partnerReachable = false;
          break;
        }
        const status = await coordinator.waitForPartner(cid);
        if (status.ok && /picked up parcel/i.test(status.detail ?? "")) {
          collected++;
          partnerHasLoad = true;
          if (target != null && collected >= target) break;
          continue;
        }
        // ok with no pickup detail = nothing more reachable but the teammate is
        // already carrying a load to hand off; not-ok = it has nothing at all.
        if (status.ok) partnerHasLoad = true;
        break;
      }

      if (!partnerReachable) {
        try { await coordinator.directPartner("resume"); } catch {}
        return makeToolResult(
          "Handoff failed: could not reach the teammate to start the pickup.",
          { terminal: true }
        );
      }
      if (!partnerHasLoad) {
        try { await coordinator.directPartner("resume"); } catch {}
        return makeToolResult(
          "Handoff failed: the teammate found no parcel it could reach to hand off.",
          { terminal: true }
        );
      }

      // 2) Bring the load to the collector before dropping. With exploration (or
      // a far self-selected pickup) the teammate can finish picking up anywhere on
      // the map; dropping at its feet there would strand the parcels somewhere THIS
      // agent then fails to reach within its few short collect retries — the bug
      // behind "teammate dropped the load but you could not collect it". Walk the
      // teammate to within one tile of this agent first, so the drop lands right
      // next to the collector and step 4 is a trivial, reliable pickup. Best-effort:
      // if the approach can't be sent, fall through and drop wherever it is.
      if (bs.me?.x != null && bs.me?.y != null) {
        const approach = await coordinator.directPartner("go_near", {
          x: bs.me.x,
          y: bs.me.y,
          maxDist: 1,
        });
        if (approach.delivered) await coordinator.waitForPartner(approach.cid);
        // Let sensing refresh the teammate's new (now-adjacent) position before it
        // is read as the drop tile, so the upcoming putdown is not aimed back at
        // the teammate's old far cell.
        await wait(RENDEZVOUS_SELF_RETRY_DELAY_MS);
      }

      // 3) Drop tile = the teammate's own current cell (drop-at-feet): reachable
      // by it with zero detour, never this agent's cell, and now next to this one.
      const dropTile =
        bs.partner && bs.partner.x != null && bs.partner.y != null
          ? { x: bs.partner.x, y: bs.partner.y }
          : null;
      if (dropTile == null) {
        try { await coordinator.directPartner("resume"); } catch {}
        return makeToolResult(
          "Handoff failed: the teammate's position is unknown, so no drop tile could be chosen.",
          { terminal: true }
        );
      }

      // 4) Teammate drops the whole stack here and vacates. The putdown status is
      // only sent after the BDI has stepped off the tile (see #vacateAfterDrop),
      // so the cell is guaranteed free by the time this resolves.
      const drop = await coordinator.directPartner("putdown", {
        x: dropTile.x,
        y: dropTile.y,
      });
      const dropStatus = drop.delivered
        ? await coordinator.waitForPartner(drop.cid)
        : { ok: false, detail: "teammate not reachable" };
      if (!dropStatus.ok) {
        try { await coordinator.directPartner("resume"); } catch {}
        return makeToolResult(
          `Handoff failed: teammate could not drop at (${dropTile.x},${dropTile.y}): ${dropStatus.detail ?? "unknown reason"}.`,
          { terminal: true }
        );
      }

      // 5) Collect the dropped stack. Retry: a first sweep can transiently fail
      // while the teammate is still clearing the neighbour it vacated to.
      //
      // Detect success by THIS agent's carried-count delta, NOT by emitPickup's
      // return value: stepping onto the drop tile fires opportunisticActions,
      // which auto-grabs the free parcels lying there before goPickUp's own
      // emitPickup runs — so the explicit pickup returns [] even though the load
      // WAS collected. Counting the carry delta covers both the auto-grab and the
      // explicit pickup, ending the false "you could not collect it" report.
      const carriedBefore = bs.carry?.count ?? 0;
      let explicitlyPicked = 0;
      for (let attempt = 0; attempt < RENDEZVOUS_SELF_ATTEMPTS; attempt++) {
        try {
          const got = await actions.goPickUp(dropTile.x, dropTile.y);
          if (Array.isArray(got)) explicitlyPicked += got.length;
        } catch {
          // fall through to retry
        }
        // Either the explicit pickup returned parcels, or the auto-grab on arrival
        // already raised the carried count — both mean the load was collected.
        if (explicitlyPicked > 0 || (bs.carry?.count ?? 0) > carriedBefore) break;
        if (attempt < RENDEZVOUS_SELF_ATTEMPTS - 1) {
          await wait(RENDEZVOUS_SELF_RETRY_DELAY_MS);
        }
      }

      const pickedCount = Math.max(
        explicitlyPicked,
        (bs.carry?.count ?? 0) - carriedBefore
      );

      if (pickedCount === 0) {
        try { await coordinator.directPartner("resume"); } catch {}
        return makeToolResult(
          `Handoff incomplete: teammate dropped the load at (${dropTile.x},${dropTile.y}) but you could not collect it.`,
          { terminal: true }
        );
      }

      // 6) Deliver the collected load (default). goDropOff banks into the shared
      // deliveredParcels counter only on a real delivery tile, so the before/after
      // delta is the count actually scored — reported in the reply the same way
      // collect_and_deliver does (a terminal tool whose result IS the reply).
      let deliveredNow = 0;
      let deliverNote = "";
      if (shouldDeliver) {
        const before = bs.metrics?.deliveredParcels ?? 0;
        const dest = nearestDeliveryTileAt(bs.me, bs.map.deliveryDistanceMap);
        if (dest) {
          try {
            await actions.goDropOff(dest.tile.x, dest.tile.y);
          } catch (error) {
            deliverNote = ` (delivery failed: ${error?.message ?? error})`;
          }
        } else {
          deliverNote = " (no reachable delivery tile)";
        }
        deliveredNow = (bs.metrics?.deliveredParcels ?? 0) - before;
      }

      try { await coordinator.directPartner("resume"); } catch {}

      const tail = shouldDeliver
        ? ` and delivered ${deliveredNow}${deliverNote}.`
        : " (left carried; no delivery requested).";
      return makeToolResult(
        `Handoff complete: teammate handed off ${pickedCount} parcel(s) at (${dropTile.x},${dropTile.y}); you collected ${pickedCount}${tail}`,
        { terminal: true }
      );
    }

    case "calculate":
      return makeToolResult(calculate(params));

    case "find_delivery_tile":
      return makeToolResult(findDeliveryTile(params, bs));

    case "go_to": {
      const tileError = validateTile(params.x, params.y, bs);
      if (tileError) return makeToolResult(tileError);
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
      const tileError = validateTile(params.x, params.y, bs);
      if (tileError) return makeToolResult(tileError);
      try {
        const picked = await actions.goPickUp(params.x, params.y, params.parcelId);
        if (!Array.isArray(picked) || picked.length === 0) {
          return makeToolResult(
            `No parcel was picked up at (${params.x}, ${params.y}) — none is there.`
          );
        }
        return makeToolResult(
          `Picked up ${picked.length} parcel(s) at (${params.x}, ${params.y}).`
        );
      } catch (error) {
        return makeToolResult(
          `Could not pick up at (${params.x}, ${params.y}): ${error?.message ?? error}.`
        );
      }
    }

    case "go_drop_off": {
      // Must be a real in-map tile, but NOT necessarily a delivery tile: a
      // Level-3 handoff legitimately drops parcels on a plain tile for the
      // partner to collect. validateTile guards the out-of-map / non-integer
      // garbage the model could emit; the delivery-tile distinction below only
      // decides whether this counts as a scored delivery.
      const tileError = validateTile(params.x, params.y, bs);
      if (tileError) {
        return makeToolResult(tileError, {
          deliverySucceeded: false,
          deliveredCount: 0,
        });
      }
      const isDeliveryDrop =
        validateDeliveryTile(params.x, params.y, bs) === null;
      try {
        const carried = [...bs.parcels.values()].filter(
          (parcel) => parcel.carriedBy === bs.me.id
        ).length;

        await actions.goDropOff(params.x, params.y);

        if (isDeliveryDrop) {
          return makeToolResult(
            `Delivered ${carried} parcel(s) at (${params.x}, ${params.y}).`,
            { deliverySucceeded: true, deliveredCount: carried }
          );
        }
        // Handoff drop on a non-delivery tile: report honestly — no reward is
        // banked here, so it is NOT a delivery.
        return makeToolResult(
          `Dropped ${carried} parcel(s) at (${params.x}, ${params.y}) for handoff (not a delivery tile — no reward banked).`,
          { deliverySucceeded: false, deliveredCount: 0 }
        );
      } catch (error) {
        return makeToolResult(
          `Could not drop at (${params.x}, ${params.y}): ${error?.message ?? error}.`,
          { deliverySucceeded: false, deliveredCount: 0 }
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

    case "clear_navigation_rules":
      return makeToolResult(clearNavigationRules(params, bs));

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

    // The autonomous BDI loop keeps harvesting while the LLM interprets the
    // message. It is paused lazily — only the first time a body-driving /
    // coordination tool is about to run (see BDI_PAUSING_TOOLS) — so a pure
    // rule/query mission never interrupts play. Resumed in finally; pause() and
    // resume() are idempotent, so a no-op resume after a non-pausing mission is
    // harmless. pausedForMission also guards the up-front pause from firing
    // twice within one mission.
    let pausedForMission = false;
    const pauseBdiForMission = () => {
      if (pausedForMission) return;
      // pause() preempts the running intention (re-queued, not failed) before
      // the executor issues any movement of its own.
      bdi.pause();
      pausedForMission = true;
    };

    try {
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

        // A self-moving tool is about to take exclusive control of the agent's
        // body: stop the autonomous loop now (once) so it does not fight the
        // task. Rule/query and teammate-only coordination tools fall through and
        // the loop keeps harvesting.
        if (BDI_PAUSING_TOOLS.has(action.name)) {
          pauseBdiForMission();
        }

        const toolResult = await executeTool(
          action,
          bs,
          llmState,
          actions,
          missionStats,
          coordinator,
          bdi,
          moreToDo
        );
        const observation = toolResult.observation;

        // Red light: a directive that just parked the partner on an external
        // signal (direct_partner "wait") freezes this agent too — the whole team
        // stops until a later green-light mission clears the park (the finally
        // then resumes). Pause now so this agent stops harvesting the moment it
        // calls the red light, not only when the mission ends.
        if (llmState.coordination.partnerParkedOn) {
          pauseBdiForMission();
        }

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

      // Resume this agent's own autonomous BDI loop — UNLESS we are parked on an
      // external signal (red light / green light). Then THIS agent must also stay
      // frozen, not wander off, until the operator's signal arrives: a later
      // "green" mission clears partnerParkedOn and resumes it. The message router
      // still delivers that mission while the BDI loop is paused.
      if (!llmState.coordination.partnerParkedOn) {
        bdi.resume();
      }
    }

    }); // end missionQueue.enqueue
  });
}