import { findPath } from "../pathfinding/pathfinding.js";
import { AGENT_CONFIG, } from "../config.js";
import { RUNTIME, CAMP_PATROL_RADIUS } from "../utils/constants.js";
import { yieldControl, wait } from "../utils/asyncUtils.js";
import {
  findCellsToExplore,
  isDeliveryTile,
  isOccupied,
  DIRECTIONS,
} from "../utils/mapUtils.js";
import { spawnMapDistance } from "../utils/stateUtils.js";
import { effectiveCapacity } from "../bdi/options.js";
import {
  recordStepDecaySample,
  movementDurationMs,
} from "../utils/decayModel.js";

/*
 * Creates the action layer for a specific agent.
 * Receives socket and beliefState of the agent instead of importing them as singletons.
 * Returns an object with all available action functions.
 */
/*
 * Exposes the agent's operational actions above the game socket.
 */
export function createActions(socket, bs, options = {}) {
  function getBlockedTiles() {
    return options.blockedTiles ?? new Set();
  }

  /*
   * Moves the agent in a direction and updates the local position.
   * A refused move (another agent on the target tile) throws an error
   * tagged with `movementBlocked`, so callers can tell a transient block
   * apart from any other failure and react with retry/replan instead of
   * failing the whole intention.
   */
  async function move(direction) {
    const moved = await socket.emitMove(direction);

    if (!moved) {
      // A refused move is a control signal, not an exception: executePath/goTo
      // read movementBlocked + blockedTile to drive yield/retry/replan, and it
      // only reaches the loop's failure logger after repeated replans all fail.
      // Throw a plain object (no captured stack) rather than an Error so those
      // flags stay intact while the log shows one clean line, not a stack trace.
      // blockedTile records exactly which tile the server refused, so the
      // replanner avoids this proven-blocked tile (see goTo) instead of
      // re-entering it.
      const delta = DIRECTIONS.find((d) => d.move === direction);
      throw {
        movementBlocked: true,
        blockedTile: delta
          ? {
              x: Math.round(bs.me.x) + delta.dx,
              y: Math.round(bs.me.y) + delta.dy,
            }
          : undefined,
        message: `Movement failed: ${direction} — will retry`,
      };
    }

    bs.me.x = moved.x;
    bs.me.y = moved.y;

    return moved;
  }

  /*
   * Asks the server to pick up the parcel on the current cell. A pickup that
   * actually collects something marks this tile as the camp anchor hint: camp
   * should loiter where we *harvest*, not merely where we *see* parcels (a
   * sighting we keep losing to a closer opponent is worthless). Under a uniform
   * spawn rate this realized-harvest signal is what distinguishes a productive
   * pocket from a contested one.
   */
  async function pickup() {
    const picked = await socket.emitPickup();

    if (Array.isArray(picked) && picked.length > 0) {
      bs.lastParcelHint = {
        x: Math.round(bs.me.x),
        y: Math.round(bs.me.y),
        ts: Date.now(),
      };
    }

    return picked;
  }

  /*
   * Releases the carried parcel on the current cell.
   */
  async function putdown() {
    return await socket.emitPutdown();
  }

  /*
   * Number of parcels currently carried by this agent. Reads the cached count
   * maintained by the belief update (the carried set only changes on sensing).
   */
  function carriedCount() {
    return bs.carry?.count ?? 0;
  }

  /*
   * Zero-detour opportunities on the tile just entered: grab a free parcel
   * lying here (if there is spare capacity) and bank the carried parcels if
   * this happens to be a delivery tile. Both cost no extra steps, so they
   * are always worth doing regardless of the current intention.
   */
  async function opportunisticActions() {
    const x = Math.round(bs.me.x);
    const y = Math.round(bs.me.y);

    if (carriedCount() < effectiveCapacity(bs)) {
      for (const parcel of bs.parcels.values()) {
        if (
          !parcel.carriedBy &&
          Math.round(parcel.x) === x &&
          Math.round(parcel.y) === y
        ) {
          await pickup();
          break;
        }
      }
    }

    if (
      carriedCount() > 0 &&
      isDeliveryTile(x, y, bs.map.deliveryTiles ?? [])
    ) {
      await putdown();
    }
  }

  /*
   * Executes a path step by step, with stop and timeout.
   * A step blocked by another agent is retried a few times before giving
   * up (most blocks are a crossing agent that clears within a moment); if
   * it stays blocked the tagged error propagates to goTo, which replans.
   */
  async function executePath(
    path,
    {
      shouldStop = () => false,
      onStep = null,
      timeoutMs = RUNTIME.GO_TO_TIMEOUT_MS,
      replan = null,
    } = {}
  ) {
    const startedAt = Date.now();

    // Decay ticks observed at the previous move-ack. The number of ticks
    // that land between two consecutive acks is a direct, clock-free sample of
    // how much reward each carried parcel loses per tile of travel (see
    // utils/decayModel.js). The window stays valid across an in-walk path swap:
    // the move-acks are still consecutive in time.
    let ticksAtPreviousAck = null;

    let i = 0;
    while (i < path.length) {
      const direction = path[i];

      if (shouldStop()) throw ["stopped"];

      if (timeoutMs != null && Date.now() - startedAt > timeoutMs) {
        // Leg took too long (congestion / a slow contested route). Transient
        // and re-probed after the flat retry cooldown — throw a plain string so
        // the loop's failure logger prints one clean notice, not a stack trace.
        throw "go_to timeout — will retry";
      }

      for (let attempt = 0; ; attempt++) {
        try {
          await move(direction);
          break;
        } catch (error) {
          if (!error?.movementBlocked) throw error;

          // Only a moving agent on the target tile is worth waiting for:
          // yield in place with a randomized backoff so two agents caught
          // mirroring each other desynchronize and one slips through. Any
          // other block (wall, crate, or one we can't confirm) won't clear by
          // waiting, so it propagates straight to goTo, which reroutes.
          const blockedByAgent =
            error.blockedTile &&
            isOccupied(error.blockedTile.x, error.blockedTile.y, bs.agents);
          if (!blockedByAgent || attempt >= RUNTIME.YIELD_RETRY_LIMIT) {
            throw error;
          }

          await wait(
            Math.random() *
              RUNTIME.YIELD_BACKOFF_MOVE_FACTOR *
              movementDurationMs(bs)
          );
          if (shouldStop()) throw ["stopped"];
        }
      }

      if (ticksAtPreviousAck != null) {
        recordStepDecaySample(bs, bs.timing.decayTicks - ticksAtPreviousAck);
      }
      ticksAtPreviousAck = bs.timing.decayTicks;

      await opportunisticActions();

      if (onStep) await onStep();

      if (shouldStop()) throw ["stopped"];

      i++;

      // Reconsider while walking: re-path from the current position against the
      // latest beliefs and switch only to a strictly shorter route (>= 1 tile).
      // This retries a just-cleared shortcut the moment it opens — while the
      // choke is still in sensing — and reroutes early when an agent steps onto
      // the path ahead, instead of waiting to physically bump it. The length
      // hysteresis stops equal-length routes flapping as agents jitter. An
      // opportunistic switch is not a failure: it records no avoid tile and
      // does not spend goTo's replan budget.
      if (replan && i < path.length) {
        const candidate = replan();
        if (
          candidate &&
          Array.isArray(candidate.path) &&
          candidate.path.length < path.length - i
        ) {
          path = candidate.path;
          i = 0;
        }
      }

      await yieldControl();
    }

    return true;
  }

  /*
   * Reaches a map position using the active pathfinding.
   * When a step stays blocked after the in-place retries, the path is
   * recomputed from the current position (the blocking agent is in beliefs
   * by then, so the new path routes around it); the intention fails only
   * after several consecutive replans.
   * The timeout is proportional to the path length, so long legs don't
   * spuriously time out and short legs fail fast; callers can still force
   * a fixed timeout via timeoutMs.
   */
  async function goTo(
    x,
    y,
    {
      shouldStop = () => false,
      timeoutMs = null,
    } = {}
  ) {
    // Tiles where a move was physically refused, each remembered for only a
    // short, movement-scaled tenure (AVOID_TENURE_MOVE_FACTOR). A* hard-avoids
    // the still-fresh ones, so the planner stops re-entering a corridor it just
    // bounced off; but the memory expires within a move or two, so a cleared
    // choke becomes eligible again while the blocker is still in sensing and
    // the reconsider-while-walking step can pick the shorter route back up.
    const avoidUntil = new Map(); // "x,y" -> expiry timestamp (ms)

    const activeAvoid = () => {
      const now = Date.now();
      const set = new Set();
      for (const [key, expiry] of avoidUntil) {
        if (expiry > now) set.add(key);
        else avoidUntil.delete(key);
      }
      return set;
    };

    const planFrom = (pos, avoid = activeAvoid()) =>
      findPath(pos, { x, y }, AGENT_CONFIG.pathfinding.algorithm, bs, {
        blockedTiles: getBlockedTiles(),
        avoidTiles: avoid,
      });

    for (let replans = 0; ; replans++) {
      let result = planFrom(bs.me);

      // Reachability fallback: if avoiding the proven-blocked tiles leaves no
      // path at all (the choke is the only way through), drop the avoid set
      // for this attempt and retry the choke — better to wait it out than to
      // falsely fail an otherwise-reachable target.
      if ((!result || !Array.isArray(result.path)) && avoidUntil.size > 0) {
        result = planFrom(bs.me, new Set());
      }

      if (!result || !Array.isArray(result.path)) {
        // No route to the target right now — usually a transient block (agents
        // boxing a choke within the hard-obstacle radius) that clears as they
        // move; the intention fails and is re-probed after the flat retry
        // cooldown. Throw a plain string, not an Error, so the loop's failure
        // logger prints one clean notice instead of a full stack trace.
        throw `Path not found to (${x}, ${y}) — will retry`;
      }

      const effectiveTimeoutMs =
        timeoutMs ??
        Math.max(
          RUNTIME.GO_TO_TIMEOUT_MS,
          result.path.length *
            movementDurationMs(bs) *
            RUNTIME.GO_TO_TIMEOUT_SAFETY_FACTOR
        );

      try {
        return await executePath(result.path, {
          shouldStop,
          timeoutMs: effectiveTimeoutMs,
          replan: () => planFrom(bs.me),
        });
      } catch (error) {
        if (!error?.movementBlocked || replans >= RUNTIME.MAX_REPLANS) {
          throw error;
        }
        // Remember the choke briefly so the next replan routes around it.
        if (error.blockedTile) {
          avoidUntil.set(
            `${error.blockedTile.x},${error.blockedTile.y}`,
            Date.now() +
              RUNTIME.AVOID_TENURE_MOVE_FACTOR * movementDurationMs(bs)
          );
        }
      }
    }
  }

  /*
   * Goes to the parcel and tries to pick it up.
   */
  async function goPickUp(
    x,
    y,
    parcelId = null,
    { shouldStop = () => false } = {}
  ) {
    await goTo(x, y, { shouldStop });
    if (shouldStop()) throw ["stopped"];
    return await pickup();
  }

  /*
   * Goes to a delivery tile and deposits the carried parcels.
   */
  async function goDropOff(
    x,
    y,
    { shouldStop = () => false } = {}
  ) {
    await goTo(x, y, { shouldStop });
    if (shouldStop()) throw ["stopped"];
    return await putdown();
  }

  /*
   * Tries to explore a not-too-recently-visited spawn tile.
   */
  async function explore({ shouldStop = () => false } = {}) {
    const candidates = findCellsToExplore(
      bs.map.spawnTiles,
      bs.me
    );

    if (!candidates || candidates.length === 0) {
      throw new Error("No spawn tiles available");
    }

    for (const cell of candidates) {
      try {
        await goTo(cell.x, cell.y, { shouldStop });
        return true;
      } catch (error) {
        if (Array.isArray(error) && error[0] === "stopped") {
          throw error;
        }
        continue;
      }
    }

    // Every spawn tile is momentarily unreachable — the agent is boxed in by
    // other agents at a choke. This is an expected, transient condition (it
    // clears as they move), so the intention still fails and is re-probed after
    // the flat retry cooldown, but we throw a plain string instead of an Error:
    // the loop's failure logger prints it as a single clean notice rather than
    // dumping a full stack trace that looks like a crash.
    throw "No reachable spawn tile (boxed in) — will retry";
  }

  /*
   * Picks the tile to camp around: the place a parcel was most recently
   * picked up (if the harvest is still fresh), otherwise the nearest spawn
   * tile — "wait where I last collected a parcel, else where parcels are born".
   */
  /*
   * Camp neighbourhood radius: the agent can only meaningfully watch as far as
   * it senses, so the camp anchor search and the patrol footprint both scale to
   * the observation distance instead of a fixed constant. Falls back to
   * CAMP_PATROL_RADIUS when the server hasn't declared an observation distance.
   */
  function campRadius() {
    const obsDist = bs.config?.observationDistance;
    return Number.isFinite(obsDist) && obsDist > 0
      ? Math.ceil(obsDist)
      : CAMP_PATROL_RADIUS;
  }

  function pickCampAnchor() {
    const me = bs.me;
    // Camp only runs once the scorer has judged the pocket hot, so a recent
    // hint exists; the spawn-tile search is a defensive fallback only.
    const hint = bs.lastParcelHint;
    if (hint) {
      // Center the camp on the local spawn cluster rather than the exact tile a
      // parcel was last picked up on — on a big green zone that tile is often an
      // edge, leaving the agent camping a corner. Take the centroid of the spawn
      // tiles within the view radius of the hint and snap it to the nearest spawn
      // tile, so the agent sits where it can watch the most of the pocket.
      const radius = campRadius();
      const near = (bs.map.spawnTiles ?? []).filter(
        (t) => Math.abs(t.x - hint.x) + Math.abs(t.y - hint.y) <= radius
      );
      if (near.length === 0) return { x: hint.x, y: hint.y };

      let sumX = 0;
      let sumY = 0;
      for (const t of near) {
        sumX += t.x;
        sumY += t.y;
      }
      const cx = sumX / near.length;
      const cy = sumY / near.length;

      let best = null;
      let bestDist = Infinity;
      for (const t of near) {
        const d = Math.abs(t.x - cx) + Math.abs(t.y - cy);
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
      return best ? { x: best.x, y: best.y } : { x: hint.x, y: hint.y };
    }

    let best = null;
    let bestDist = Infinity;
    for (const tile of bs.map.spawnTiles ?? []) {
      const d =
        spawnMapDistance(bs.map.spawnDistanceMap, me, tile) ??
        Math.abs(tile.x - Math.round(me.x)) +
          Math.abs(tile.y - Math.round(me.y));
      if (d < bestDist) {
        bestDist = d;
        best = tile;
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /*
   * Spawn tiles forming the pocket around the anchor; the patrol loops over
   * these so the agent keeps the whole cluster in view instead of freezing on
   * one cell. The footprint scales to the view radius so every patrol position
   * keeps its neighbours visible. Falls back to the anchor itself if no spawn
   * tiles are nearby.
   */
  function campPatrolTiles(anchor) {
    const radius = campRadius();
    const near = (bs.map.spawnTiles ?? []).filter(
      (t) => Math.abs(t.x - anchor.x) + Math.abs(t.y - anchor.y) <= radius
    );
    return near.length > 0 ? near : [anchor];
  }

  /*
   * Camps a productive parcel pocket: loiter near where parcels appear and
   * patrol the local cluster so new spawns are grabbed at once, instead of
   * wandering off the moment the view is empty.
   *
   * Camp does one thing only — patrol the pocket — and runs until preempted.
   * It never explores or delivers itself: when the pocket goes cold (or the
   * carry loss budget runs out), intentionScore makes camp invalid and the
   * scorer hands off to a distinct `explore` intention (empty-handed) or to
   * delivery (carrying). The patrol charges the carry loss budget so the
   * scorer can enforce it.
   */
  async function camp({ shouldStop = () => false } = {}) {
    const anchor = pickCampAnchor();
    if (!anchor) return true; // nothing to camp; scorer picks explore/delivery

    try {
      await goTo(anchor.x, anchor.y, { shouldStop });
    } catch (error) {
      if (Array.isArray(error) && error[0] === "stopped") throw error;
      return true;
    }

    const patrol = campPatrolTiles(anchor);

    while (!shouldStop()) {
      for (const tile of patrol) {
        if (shouldStop()) throw ["stopped"];

        const fromX = Math.round(bs.me.x);
        const fromY = Math.round(bs.me.y);
        try {
          await goTo(tile.x, tile.y, { shouldStop });
        } catch (error) {
          if (Array.isArray(error) && error[0] === "stopped") throw error;
          continue; // unreachable patrol tile: skip, keep watching the pocket
        }

        // Charge the carry loss budget for tiles patrolled while holding
        // parcels; once it runs out, intentionScore makes camp invalid and the
        // queued delivery preempts it.
        if (carriedCount() > 0 && bs.carry) {
          bs.carry.campSteps +=
            Math.abs(tile.x - fromX) + Math.abs(tile.y - fromY);
        }
      }

      await wait(RUNTIME.MOVEMENT_RETRY_DELAY_MS);
      await yieldControl();
    }

    throw ["stopped"];
  }

  /*
   * Translates a planned predicate into the concrete action to execute.
   */
  async function executePredicate(
    predicate,
    { shouldStop = () => false } = {}
  ) {
    const [action, x, y, id] = predicate;

    if (action === "go_to") return await goTo(x, y, { shouldStop });
    if (action === "go_pick_up") return await goPickUp(x, y, id, { shouldStop });
    if (action === "go_drop_off") return await goDropOff(x, y, { shouldStop });
    if (action === "explore") return await explore({ shouldStop });
    if (action === "camp") return await camp({ shouldStop });

    throw new Error(`Unknown predicate: ${predicate.join(" ")}`);
  }

  return {
    move,
    pickup,
    putdown,
    executePath,
    goTo,
    goPickUp,
    goDropOff,
    explore,
    camp,
    executePredicate,
  };
}
