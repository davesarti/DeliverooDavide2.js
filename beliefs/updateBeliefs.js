import {
  updateSpawnStaleness,
  computeObservableTiles,
} from "../utils/mapUtils.js";
import {
  buildGrid,
  buildDeliveryDistanceMap,
  buildSpawnDistanceMap,
} from "./mapState.js";
import { decayEnabled, movementDurationMs } from "../utils/decayModel.js";
import {
  AGENT_MEMORY_TTL_MS,
  PARCEL_MEMORY_TTL_FALLBACK_MS,
} from "../utils/constants.js";

/*
 * How long an out-of-view parcel is kept in beliefs before assuming someone
 * else took it: ~2x the time needed to cross the map.
 */
function parcelMemoryTtlMs(bs) {
  const { width, height } = bs.map;
  if (!width || !height) return PARCEL_MEMORY_TTL_FALLBACK_MS;
  return 2 * (width + height) * movementDurationMs(bs);
}

/*
 * Connects socket events to the agent's internal state.
 */
export function setupBeliefUpdates(socket, bs) {

  // ==========================================
  // Configuration
  // ==========================================

  socket.onConfig((config) => {
    /*
     * Saves the game parameters needed by other parts of the agent.
     */
    const gameConfig = config.GAME ?? config;

    bs.config.observationDistance =
      gameConfig.player?.observation_distance ?? null;
    bs.config.movementDuration =
      gameConfig.player?.movement_duration ?? null;
    bs.config.playerCapacity =
      gameConfig.player?.capacity ?? null;
    bs.config.parcelDecayingEvent =
      gameConfig.parcels?.decaying_event ?? null;
    bs.config.parcelGenerationEvent =
      gameConfig.parcels?.generation_event ?? null;
    bs.config.maxParcels =
      gameConfig.parcels?.max ?? null;
  });

  // ==========================================
  // Agent State
  // ==========================================

  let lastYou = null;

  socket.onYou(({ id, name, x, y, score }) => {
    /*
     * Updates the position and score of our agent.
     */
    const current = `${id}|${x}|${y}|${score}`;
    if (current === lastYou) return;
    lastYou = current;

    bs.me.id = id;
    bs.me.name = name;
    bs.me.x = x;
    bs.me.y = y;
    bs.me.score = score;

    updateSpawnStaleness(
      bs.me,
      bs.map.spawnTiles,
      bs.config.observationDistance
    );
  });

  // ==========================================
  // Map State
  // ==========================================

  socket.onMap((width, height, tiles) => {
    /*
     * Rebuilds the internal map when the full level description arrives.
     */
    bs.map.width = width;
    bs.map.height = height;
    bs.map.tiles = tiles;
    bs.map.grid = buildGrid(width, height, tiles);

    bs.map.deliveryTiles = tiles.filter((tile) => tile.type == 2);
    bs.map.spawnTiles = tiles
      .filter((tile) => tile.type == 1)
      .map((tile) => ({ ...tile, staleness: 0 }));

    // Tiles a crate can be pushed onto. The server (Controller.move) accepts a
    // push only when the tile beyond the crate has a type starting with "5"
    // (so "5" sliding tiles and "5!" crate spawners), so we mirror that exact
    // test here. String(tile.type) guards against numeric types from older
    // maps. Used by the PDDL problem builder to emit (pushable ?t) facts.
    bs.map.pushableTiles = tiles.filter((tile) =>
      String(tile.type).startsWith("5")
    );

    bs.map.deliveryDistanceMap = buildDeliveryDistanceMap(
      width, height, tiles, bs.map.deliveryTiles
    );
    bs.map.spawnDistanceMap = buildSpawnDistanceMap(
      width, height, tiles, bs.map.spawnTiles
    );

    console.log(
      `[${bs.me.name ?? "agent"}] Map: ` +
      `${bs.map.spawnTiles.length} spawn, ` +
      `${bs.map.deliveryTiles.length} delivery, ` +
      `${bs.map.pushableTiles.length} pushable`
    );
  });

  // ==========================================
  // Sensing
  // ==========================================

  socket.onSensing((sensing) => {
    /*
     * Integrates the sensing snapshot into beliefs with object permanence:
     * a believed object is deleted only on negative evidence (its position
     * is currently observable but it is absent from the snapshot) or when
     * its memory expires — never just because it left the sensing range.
     */
    const nowMs = Date.now();

    // Observe server decay ticks before overwriting beliefs: each -1 on a
    // sensed parcel's reward is one decay event. The parcels' rewards act
    // as the game clock — no wall time is involved in this counter, which
    // feeds both the decay-per-step estimate (see utils/decayModel.js) and
    // the local decay of remembered out-of-view parcels below.
    let tickDelta = 0;
    for (const parcel of sensing.parcels ?? []) {
      const known = bs.parcels.get(parcel.id);
      if (
        known &&
        Number.isFinite(known.reward) &&
        Number.isFinite(parcel.reward)
      ) {
        tickDelta = Math.max(tickDelta, known.reward - parcel.reward);
      }
    }
    if (tickDelta > 0) bs.timing.decayTicks += tickDelta;

    // Positive evidence: refresh every sensed object.
    for (const parcel of sensing.parcels ?? []) {
      bs.parcels.set(parcel.id, { ...parcel, lastSeenMs: nowMs });
    }

    // The camp anchor hint (bs.lastParcelHint) is no longer set here from
    // *seen* parcels: a sighting only proves a parcel is present, not that we
    // can win it. It is set on a successful pickup instead (see actions.js
    // pickup), so camp anchors on zones we actually harvest — contention-aware
    // by construction, which matters since every spawn tile spawns equally.

    for (const crate of sensing.crates ?? []) {
      bs.crates.set(crate.id, crate);
    }

    // The area the server can currently sense for us (null = everything).
    const observable = computeObservableTiles(
      bs.me,
      bs.map.grid,
      bs.config.observationDistance
    );
    const isObservable = (obj) =>
      observable === null ||
      observable.has(`${Math.round(obj.x)},${Math.round(obj.y)}`);

    // Agents: keep last-seen positions briefly (they feed soft obstacles
    // and congestion estimates), with a short TTL since agents move fast.
    if (Array.isArray(sensing.agents)) {
      for (const agent of sensing.agents) {
        if (agent.id === bs.me.id) continue;
        bs.agents.set(agent.id, { ...agent, lastSeenMs: nowMs });
      }

      const sensedIds = new Set(sensing.agents.map((a) => a.id));
      for (const known of [...bs.agents.values()]) {
        if (sensedIds.has(known.id)) continue;

        const expired =
          nowMs - (known.lastSeenMs ?? 0) > AGENT_MEMORY_TTL_MS;
        if (isObservable(known) || expired) bs.agents.delete(known.id);
      }
    }

    // Crates are static obstacles, so they get object permanence (like agents
    // and parcels above): a crate is forgotten only when its tile is currently
    // observable but it is no longer there (we actually saw it leave), not just
    // because it drifted out of sensing range. Keeping out-of-view crates lets
    // the PDDL planner reason about multi-crate routes — push crate A, walk a
    // few tiles, push crate B — where B sits beyond the current view. Our own
    // pushes still update belief because we re-sense the crate's new tile from
    // the adjacent square.
    const sensedCrates = new Set((sensing.crates ?? []).map((c) => c.id));
    for (const known of [...bs.crates.values()]) {
      if (!sensedCrates.has(known.id) && isObservable(known)) {
        bs.crates.delete(known.id);
      }
    }

    // Parcels: object permanence. A parcel that merely left the sensing
    // range is kept (so walking towards a border parcel no longer destroys
    // the very intention that targets it); its believed reward decays
    // locally by the observed ticks and the belief expires after a TTL,
    // since an unseen parcel may have been taken by someone else.
    const sensedParcels = new Set((sensing.parcels ?? []).map((p) => p.id));
    const ttlMs = parcelMemoryTtlMs(bs);

    for (const known of [...bs.parcels.values()]) {
      if (sensedParcels.has(known.id)) continue;

      // Negative evidence: we can see its tile and it is not there —
      // picked up, delivered or expired.
      if (isObservable(known)) {
        bs.parcels.delete(known.id);
        continue;
      }

      if (nowMs - (known.lastSeenMs ?? 0) > ttlMs) {
        bs.parcels.delete(known.id);
        continue;
      }

      if (tickDelta > 0 && decayEnabled(bs)) {
        known.reward -= tickDelta;
        if (known.reward <= 0) bs.parcels.delete(known.id);
      }
    }

    // Single source of truth for "how many parcels do I carry". The carried
    // set only changes on sensing, so caching it here keeps it consistent with
    // bs.parcels at all times and saves every consumer (scoring, option
    // generation, execution) from re-iterating the parcel map.
    let carriedNow = 0;
    for (const parcel of bs.parcels.values()) {
      if (parcel.carriedBy === bs.me.id) carriedNow++;
    }
    if (bs.carry) {
      bs.carry.count = carriedNow;
      // The camp-while-carrying loss budget is per carry episode: once nothing
      // is carried, the budget resets so the next load starts fresh.
      if (carriedNow === 0) bs.carry.campSteps = 0;
    }

    bs.onUpdate?.();
  });
}