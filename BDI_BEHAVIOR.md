# BDI Agent — Behavior Report

A concise summary of the implementation choices behind the BDI agent's behavior.

## Decision loop

The agent runs a continuous select-and-execute cycle over a **single scored
intention queue**. Options are regenerated reactively on each sensing update and
inserted as one batch; the queue is re-sorted by score every tick so
time-varying values are re-evaluated.

- **Rate-limited reconsideration.** Every parcel decay tick fires a sensing
  event; regenerating options on each one caused churn. So options regenerate
  *immediately* only when the set of free/carried parcels changes, otherwise at
  most once per minimum interval.
- **Idle fallback.** When the queue empties, the agent explores (or camps, if a
  pocket is still hot).
- **Crash resilience.** Both option generation and the intention loop are
  supervised: a throw in either is contained/relaunched so a single bad tick or
  a collision-blocked delivery never tears down the agent. Beliefs and queue
  survive a restart.

## Option types

Five predicates compete in the same queue: `go_pick_up`, `go_drop_off`,
`explore`, and `camp`. Candidate generation only decides what is *reachable*;
the actual *worth* of each option lives entirely in the scorer, so generation
and scoring can never disagree.

## Scoring — the core of the behavior

Every choice reduces to one comparable score per option.

- **Decay is the currency.** A single quantity — reward lost per tile of travel,
  per carried parcel — drives every trade-off. It is measured purely from server
  events (decay ticks observed between consecutive move acknowledgements,
  smoothed with an EMA and seeded from server config). No wall clock is involved,
  so behavior is identical under lag or load. It is zero when parcels don't decay.
- **Pickup vs. delivery** is implicit in the score difference: both subtract a
  decay-loss term but over different routes (full pickup route vs. direct
  delivery route). Each carried parcel raises the bar for "one more pickup,"
  matching real decay economics.
- **Competition.** A parcel's reward is discounted by a sigmoid probability of
  winning the race to it against the nearest known opponent — ~1 when clearly
  closer, 0.5 on a tie, ~0 when an opponent is clearly closer. No absolute
  crowding penalty is added, since that could push a winnable parcel below the
  exploration floor.
- **Capacity.** A full agent scores all pickups invalid, leaving delivery as the
  only option. Capacity is the server-declared value, additionally capped so the
  agent always banks eventually even with no declared capacity and no decay.
- **Explore / camp** sit at tiny baseline incentives just above zero: any real
  pickup or delivery outranks them, but camp slightly outranks plain exploration.

## Preemption (commitment vs. reconsideration)

The running intention is treated as a commitment. A challenger must be *clearly*
better — beyond a hysteresis margin plus a small epsilon — to interrupt it.

- This avoids churn from negligibly-better options and naturally protects a
  delivery in final approach (its score peaks just before the tile, raising the
  bar exactly when switching would waste the most travel).
- An *invalid* running intention (score ≤ 0) is abandoned immediately; a valid
  one only yields to a clearly-superior challenger.
- While carrying, the best delivery is kept in the queue even at score 0, so the
  agent can always free itself of fully-decayed parcels.

## Failure handling

- A failed intention enters a short, **flat-cooldown** pool (no exponential
  backoff): failures are almost always transient congestion that clears quickly,
  so every predicate re-probes at the same steady interval.
- A failed delivery immediately pushes the next-nearest delivery tile, so the
  queue is never left without a delivery option while parcels decay.
- A *preempted* intention is re-queued (not penalized); a voluntarily *stopped*
  one is neither retried nor penalized.

## Movement & pathfinding

- **A\* with soft obstacles.** Agents near the start are hard obstacles (in the
  way now); agents far along the route only add a traversal penalty (they'll
  likely have moved by arrival), so a crowded corridor degrades the path instead
  of making the target unreachable.
- **Reconsider while walking.** Each step re-paths from the current position and
  switches only to a strictly shorter route, picking up a just-cleared shortcut
  immediately and rerouting before physically bumping a blocker. Length
  hysteresis prevents equal-length routes from flapping.
- **Block handling.** A refused move is a control signal, not a crash: the agent
  yields in place with randomized backoff (so two mirroring agents
  desynchronize), then briefly remembers the proven-blocked tile and replans
  around it. The intention fails only after repeated replans, with a reachability
  fallback that retries a sole choke rather than falsely failing.
- **Adaptive timeout** scales with path length, so long legs don't spuriously
  time out and short legs fail fast.

## Opportunism

On every tile entered, the agent grabs a free parcel lying there (if under
capacity) and banks carried parcels if it's a delivery tile. Both cost no extra
steps, so they're always taken regardless of the current intention.

## Beliefs

- **Object permanence.** A believed object is removed only on negative evidence
  (its tile is observable but it's absent) or when its memory expires — never
  merely because it left sensing range. This stops a parcel intention from
  destroying itself as the agent walks toward a border parcel.
- **Local decay of memory.** Out-of-view parcels have their remembered reward
  decremented by observed decay ticks and are dropped when worthless or after a
  map-crossing-scaled TTL. Agents are kept only briefly (they move fast); crates
  use plain snapshot semantics.
- **Cached carry count** is the single source of truth for "how many I carry,"
  kept consistent with beliefs on each sensing update.

## Camping

An optional behavior (on by default) to loiter at productive parcel pockets
instead of roaming.

- **Anchored on harvest, not sightings.** The camp anchor is set where a parcel
  was actually *picked up*, not merely seen — a sighting we keep losing to a
  closer opponent is worthless. The anchor is centered on the local spawn
  cluster's centroid so the agent watches the most of the pocket.
- **Adaptive patience.** Worth-waiting time is driven by spawn-cluster density:
  near-zero for a lone spawn tile (falls straight back to exploring), growing up
  to a cap for dense clusters; it is disabled entirely when the server spawns no
  new parcels. Once a pocket goes cold, the scorer invalidates camp and hands off
  to explore (empty-handed) or delivery (carrying).
- **Loss budget while carrying.** Camping with parcels is allowed only under
  capacity and within a decay-loss budget; patrol steps charge that budget, and
  when it runs out the queued delivery preempts camp. Camp itself only patrols —
  it never explores or delivers.
