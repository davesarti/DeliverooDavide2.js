/*
 * problemBuilder.js
 *
 * Translates the agent's belief state (bs) + a goal descriptor into a PDDL
 * problem string ready for the online solver.
 *
 * The domain (pddl/domain.pddl) is static and uses the predicates:
 *   tile, free, delivery, pushable, up/down/left/right,
 *   at-agent, parcel, at-parcel, carrying, delivered, crate, at-crate
 *
 * Object naming convention:
 *   tile   (x, y) -> t_<x>_<y>
 *   parcel id     -> p_<sanitized id>
 *   crate  id     -> c_<sanitized id>
 *
 * Goal descriptors accepted by buildProblem:
 *   { type: "reach_tile",       x, y }
 *   { type: "deliver_parcel",   parcelId }
 *   { type: "deliver_parcels",  parcelIds: [...] }
 *   { type: "free_tile",        x, y }
 */

const DOMAIN_NAME = "deliveroo";

// ==========================================
// Name helpers
// ==========================================

/*
 * PDDL object names must be plain tokens (no spaces, parens, quotes, or other
 * Lisp-significant characters). Game parcel/crate ids can contain arbitrary
 * characters, so we sanitize them down to [a-z0-9_].
 */
function sanitize(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function tileName(x, y) {
  return `t_${x}_${y}`;
}

function parcelName(id) {
  return `p_${sanitize(id)}`;
}

function crateName(id) {
  return `c_${sanitize(id)}`;
}

// ==========================================
// Belief-state readers
// ==========================================

/*
 * Returns the list of walkable tiles as {x, y} from the belief state.
 * bs.map.tiles is the canonical source; each entry is expected to expose x, y.
 */
function getTiles(bs) {
  return bs.map.tiles || [];
}

/*
 * Set of "t_x_y" strings for every delivery tile.
 */
function deliverySet(bs) {
  const set = new Set();
  for (const t of bs.map.deliveryTiles || []) {
    set.add(tileName(t.x, t.y));
  }
  return set;
}

/*
 * Set of "t_x_y" strings for every pushable (type-5) tile.
 * bs.map.pushableTiles is populated in updateBeliefs from the tile type sent
 * by the server. If it is missing (e.g. on a map without crates), the set is
 * empty and no push action will ever be applicable — which is correct.
 */
function pushableSet(bs) {
  const set = new Set();
  for (const t of bs.map.pushableTiles || []) {
    set.add(tileName(t.x, t.y));
  }
  return set;
}

/*
 * Quick lookup of which tiles exist (walkable), as a Set of "t_x_y".
 * Used to only emit adjacency facts between two real tiles.
 */
function tileSet(bs) {
  const set = new Set();
  for (const t of getTiles(bs)) {
    set.add(tileName(t.x, t.y));
  }
  return set;
}

// ==========================================
// Occupancy (free) computation
// ==========================================

/*
 * A tile is `free` iff it is walkable AND has no agent and no crate on it.
 * Parcels never block movement, so they are ignored here.
 *
 * We return a Set of occupied "t_x_y" names. Everything else among the
 * walkable tiles is free.
 *
 * Occupied by:
 *   - our own agent (bs.me)
 *   - every other sensed agent (bs.agents)
 *   - every crate (bs.crates)
 */
function occupiedSet(bs) {
  const occ = new Set();

  if (bs.me && bs.me.x != null && bs.me.y != null) {
    occ.add(tileName(Math.round(bs.me.x), Math.round(bs.me.y)));
  }

  for (const a of bs.agents.values()) {
    if (a.x != null && a.y != null) {
      occ.add(tileName(Math.round(a.x), Math.round(a.y)));
    }
  }

  for (const c of bs.crates.values()) {
    if (c.x != null && c.y != null) {
      occ.add(tileName(Math.round(c.x), Math.round(c.y)));
    }
  }

  return occ;
}

// ==========================================
// Adjacency facts
// ==========================================

/*
 * Emits directional adjacency facts between existing tiles.
 *
 * Convention (matches the lab / game axes):
 *   right : (x, y) -> (x+1, y)
 *   left  : (x, y) -> (x-1, y)
 *   up    : (x, y) -> (x, y+1)
 *   down  : (x, y) -> (x, y-1)
 *
 * Only emitted when BOTH tiles exist (are walkable). Walls are simply tiles
 * that don't exist, so no adjacency is generated towards them — the agent
 * can't move there.
 */
function adjacencyFacts(bs, tiles) {
  const facts = [];
  for (const t of tiles) {
    const here = tileName(t.x, t.y);

    const right = tileName(t.x + 1, t.y);
    if (tileSet(bs).has(right)) facts.push(`(right ${here} ${right})`);

    const left = tileName(t.x - 1, t.y);
    if (tileSet(bs).has(left)) facts.push(`(left ${here} ${left})`);

    const up = tileName(t.x, t.y + 1);
    if (tileSet(bs).has(up)) facts.push(`(up ${here} ${up})`);

    const down = tileName(t.x, t.y - 1);
    if (tileSet(bs).has(down)) facts.push(`(down ${here} ${down})`);
  }
  return facts;
}

// ==========================================
// Goal builders
// ==========================================

/*
 * Each goal builder returns the INNER goal conjuncts (without the outer
 * (:goal (and ...)) wrapper, which buildProblem adds).
 */
function goalReachTile(goal) {
  return [`(at-agent ${tileName(goal.x, goal.y)})`];
}

function goalDeliverParcel(goal) {
  return [`(delivered ${parcelName(goal.parcelId)})`];
}

function goalDeliverParcels(goal) {
  return (goal.parcelIds || []).map((id) => `(delivered ${parcelName(id)})`);
}

function goalFreeTile(goal) {
  return [`(free ${tileName(goal.x, goal.y)})`];
}

function buildGoalConjuncts(goal) {
  switch (goal.type) {
    case "reach_tile":
      return goalReachTile(goal);
    case "deliver_parcel":
      return goalDeliverParcel(goal);
    case "deliver_parcels":
      return goalDeliverParcels(goal);
    case "free_tile":
      return goalFreeTile(goal);
    default:
      throw new Error(`Unknown goal type: ${goal.type}`);
  }
}

// ==========================================
// Main builder
// ==========================================

/*
 * Builds a complete PDDL problem string from the belief state and a goal
 * descriptor.
 *
 * @param {object} bs    - the agent belief state
 * @param {object} goal  - a goal descriptor (see file header)
 * @returns {string}     - PDDL problem ready for onlineSolver
 *
 * The init section encodes, under the Closed-World Assumption:
 *   (tile t)        for every walkable tile
 *   (delivery t)    for every delivery tile
 *   (pushable t)    for every type-5 tile
 *   (free t)        for every walkable tile not occupied by agent/crate
 *   (right/left/up/down ...) adjacency between existing tiles
 *   (at-agent t)    the agent's current tile
 *   (parcel p) + (at-parcel p t) OR (carrying p)   for every known parcel
 *   (crate c) + (at-crate c t)                      for every known crate
 *
 * Anything not declared is false (CWA), which is exactly what we want.
 */
export function buildProblem(bs, goal) {
  const tiles = getTiles(bs);
  const deliveries = deliverySet(bs);
  const pushables = pushableSet(bs);
  const occupied = occupiedSet(bs);

  const objects = new Set();
  const init = [];

  // --- Tiles, delivery, pushable, free ---
  for (const t of tiles) {
    const name = tileName(t.x, t.y);
    objects.add(name);
    init.push(`(tile ${name})`);

    if (deliveries.has(name)) init.push(`(delivery ${name})`);
    if (pushables.has(name)) init.push(`(pushable ${name})`);
    if (!occupied.has(name)) init.push(`(free ${name})`);
  }

  // --- Adjacency ---
  for (const f of adjacencyFacts(bs, tiles)) {
    init.push(f);
  }

  // --- Agent position ---
  if (bs.me && bs.me.x != null && bs.me.y != null) {
    const myTile = tileName(Math.round(bs.me.x), Math.round(bs.me.y));
    init.push(`(at-agent ${myTile})`);
  }

  // --- Parcels ---
  // A parcel currently carried by us is encoded as (carrying p); a parcel on
  // the floor is encoded as (at-parcel p t). A parcel carried by SOMEONE ELSE
  // is irrelevant to our plan and is skipped entirely.
  const myId = bs.me ? bs.me.id : null;
  for (const [id, p] of bs.parcels.entries()) {
    // skip parcels carried by another agent
    if (p.carriedBy && p.carriedBy !== myId) continue;

    const name = parcelName(id);
    objects.add(name);
    init.push(`(parcel ${name})`);

    if (p.carriedBy && p.carriedBy === myId) {
      init.push(`(carrying ${name})`);
    } else if (p.x != null && p.y != null) {
      init.push(`(at-parcel ${name} ${tileName(Math.round(p.x), Math.round(p.y))})`);
    }
  }

  // --- Crates ---
  for (const [id, c] of bs.crates.entries()) {
    if (c.x == null || c.y == null) continue;
    const name = crateName(id);
    objects.add(name);
    init.push(`(crate ${name})`);
    init.push(`(at-crate ${name} ${tileName(Math.round(c.x), Math.round(c.y))})`);
  }

  // --- Goal ---
  const goalConjuncts = buildGoalConjuncts(goal);

  // --- Assemble ---
  const objectsStr = Array.from(objects).join(" ");
  const initStr = init.join("\n        ");
  const goalStr = goalConjuncts.join("\n            ");

  return `;; auto-generated problem
(define (problem deliveroo-problem)
    (:domain ${DOMAIN_NAME})
    (:objects ${objectsStr})
    (:init
        ${initStr}
    )
    (:goal (and
            ${goalStr}
        )
    )
)
`;
}

// Exposed for testing / reuse.
export { tileName, parcelName, crateName, sanitize };