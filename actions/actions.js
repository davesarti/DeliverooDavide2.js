import { findPath } from "../pathfinding/pathfinding.js";
import { AGENT_CONFIG, } from "../config.js";
import { RUNTIME, HOARD_CAP, CAMP_PATROL_RADIUS } from "../utils/constants.js";
import { yieldControl, wait } from "../utils/asyncUtils.js";
import {
  findCellsToExplore,
  isDeliveryTile,
  isOccupied,
  DIRECTIONS,
} from "../utils/mapUtils.js";
import { spawnMapDistance } from "../utils/stateUtils.js";
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
      const error = new Error(`Movement failed: ${direction}`);
      error.movementBlocked = true;
      // Record exactly which tile the server refused, so the replanner can
      // avoid this proven-blocked tile (see goTo) instead of re-entering it.
      const delta = DIRECTIONS.find((d) => d.move === direction);
      if (delta) {
        error.blockedTile = {
          x: Math.round(bs.me.x) + delta.dx,
          y: Math.round(bs.me.y) + delta.dy,
        };
      }
      throw error;
    }

    bs.me.x = moved.x;
    bs.me.y = moved.y;

    return moved;
  }

  /*
   * Asks the server to pick up the parcel on the current cell.
   */
  async function pickup() {
    return await socket.emitPickup();
  }

  /*
   * Releases the carried parcel on the current cell.
   */
  async function putdown() {
    return await socket.emitPutdown();
  }

  /*
   * Number of parcels currently carried by this agent.
   */
  function carriedCount() {
    let count = 0;
    for (const parcel of bs.parcels.values()) {
      if (parcel.carriedBy === bs.me.id) count++;
    }
    return count;
  }

  /*
   * Max parcels worth carrying: the server-declared capacity, additionally
   * capped by HOARD_CAP so the agent always banks eventually even when the
   * server declares no capacity and parcels do not decay.
   */
  function effectiveCapacity() {
    const declared = Number(bs.config.playerCapacity);
    const capacity =
      Number.isFinite(declared) && declared > 0 ? declared : Infinity;
    return Math.min(capacity, HOARD_CAP);
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

    if (carriedCount() < effectiveCapacity()) {
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
    } = {}
  ) {
    const startedAt = Date.now();

    // Decay ticks observed at the previous move-ack. The number of ticks
    // that land between two consecutive acks of the same path is a direct,
    // clock-free sample of how much reward each carried parcel loses per
    // tile of travel (see utils/decayModel.js).
    let ticksAtPreviousAck = null;

    for (const direction of path) {
      if (shouldStop()) throw ["stopped"];

      if (timeoutMs != null && Date.now() - startedAt > timeoutMs) {
        throw new Error("go_to timeout");
      }

      for (let attempt = 0; ; attempt++) {
        try {
          await move(direction);
          break;
        } catch (error) {
          if (!error?.movementBlocked) throw error;

          // A moving agent sitting on the target tile (not a wall/crate):
          // yield in place with a randomized backoff so two agents caught
          // mirroring each other desynchronize and one slips through. A
          // static blocker exhausts the smaller retry budget quickly and
          // falls through to goTo's reroute.
          const blockedByAgent =
            error.blockedTile &&
            isOccupied(error.blockedTile.x, error.blockedTile.y, bs.agents);

          const limit = blockedByAgent
            ? RUNTIME.YIELD_RETRY_LIMIT
            : RUNTIME.MOVE_RETRY_LIMIT;
          if (attempt >= limit) throw error;

          const delayMs = blockedByAgent
            ? RUNTIME.YIELD_BACKOFF_MIN_MS +
              Math.random() *
                (RUNTIME.YIELD_BACKOFF_MAX_MS - RUNTIME.YIELD_BACKOFF_MIN_MS)
            : RUNTIME.MOVEMENT_RETRY_DELAY_MS;
          await wait(delayMs);
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
    // Tiles where a move was just physically refused, accumulated across the
    // replans of this single goTo. Each replan hard-avoids all of them, so
    // once both corridors of a two-route block are proven blocked the planner
    // is forced onto the longer open route instead of ping-ponging between
    // the two blocked ones. Reset implicitly: the set is scoped to this call.
    const avoidTiles = new Set();

    for (let replans = 0; ; replans++) {
      let result = findPath(
        bs.me,
        { x, y },
        AGENT_CONFIG.pathfinding.algorithm,
        bs,
        { blockedTiles: getBlockedTiles(), avoidTiles }
      );

      // Reachability fallback: if avoiding the proven-blocked tiles leaves no
      // path at all (the choke is the only way through), drop the avoid set
      // for this attempt and retry the choke — better to wait it out than to
      // falsely fail an otherwise-reachable target.
      if ((!result || !Array.isArray(result.path)) && avoidTiles.size > 0) {
        result = findPath(
          bs.me,
          { x, y },
          AGENT_CONFIG.pathfinding.algorithm,
          bs,
          { blockedTiles: getBlockedTiles() }
        );
      }

      if (!result || !Array.isArray(result.path)) {
        throw new Error(`Path not found to (${x}, ${y})`);
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
        });
      } catch (error) {
        if (!error?.movementBlocked || replans >= RUNTIME.MAX_REPLANS) {
          throw error;
        }
        // Remember the choke so the next replan routes around it.
        if (error.blockedTile) {
          avoidTiles.add(`${error.blockedTile.x},${error.blockedTile.y}`);
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

    throw new Error("No reachable spawn tile");
  }

  /*
   * Picks the tile to camp around: the place a free parcel was most recently
   * seen (if the sighting is still fresh), otherwise the nearest spawn tile —
   * "wait where I last saw a parcel, else where parcels are born".
   */
  function pickCampAnchor() {
    const me = bs.me;
    // Camp only runs once the scorer has judged the pocket hot, so a recent
    // hint exists and is the anchor; the spawn-tile search is a defensive
    // fallback only.
    const hint = bs.lastParcelHint;
    if (hint) return { x: hint.x, y: hint.y };

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
   * one cell. Falls back to the anchor itself if no spawn tiles are nearby.
   */
  function campPatrolTiles(anchor) {
    const near = (bs.map.spawnTiles ?? []).filter(
      (t) =>
        Math.abs(t.x - anchor.x) + Math.abs(t.y - anchor.y) <=
        CAMP_PATROL_RADIUS
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
