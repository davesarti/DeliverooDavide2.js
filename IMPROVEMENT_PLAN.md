# BDI Agent — Behavior Improvement Plan & Supporting Report

Scope: pure BDI pipeline (`bdi/`, `beliefs/`, `actions/`, `pathfinding/`, `utils/`).
The LLM layer is ignored. The BDI skeleton (`IntentionRevision` loop /
`Intention` / `optionsGeneration` structure) is **not** modified — all changes
are inside belief management, option generation, scoring, execution, and
failure handling, which plug into the existing skeleton.

---

## Part 1 — Diagnosis: mapping each observed symptom to its root cause

### S1. Parcels at the sensing border "disappear" and the intention is discarded

- The server senses parcels with a BFS bounded by `observation_distance`
  (`Deliveroo.js/backend/src/deliveroo/Sensor.js`, `computeSensing`). A parcel
  exactly at the border leaves the sensing set as soon as the agent moves one
  tile away from it.
- The belief update **deletes every parcel that is not in the latest sensing
  snapshot** (`beliefs/updateBeliefs.js:131-134`), regardless of whether its
  position is currently observable. Sensing-set membership is treated as
  existence.
- The intention loop then discards the `go_pick_up` intention because the
  parcel is gone from beliefs (`bdi/bdiAgent.js:233-241`, "Skipping invalid
  intention").

So the agent has no object permanence: walking *towards* a border parcel makes
it forget the parcel it is walking towards (the parcel only re-enters sensing
when the agent gets close again — but the intention was already dropped and
options regeneration may by then prefer something else).

### S2. Deliveries are missed (carried parcels never delivered)

Four independent causes, all in the execution/revision layer:

1. **No retry on blocked moves.** `move()` throws on the first failed
   `emitMove` (`actions/actions.js:23-25`). A single collision with a crossing
   agent fails the whole `go_drop_off` intention. `MOVEMENT_RETRY_DELAY_MS`
   and `MAX_CONSECUTIVE_WAITS` exist in `utils/constants.js:20-21` but are
   **never used**.
2. **Agents are hard obstacles in pathfinding.** `canUseNeighborTile`
   (`utils/mapUtils.js:159-175`) excludes every tile occupied by any sensed
   agent. If a (moving!) agent momentarily sits on the only corridor to the
   delivery tile, `findPath` returns null → "Path not found" → intention
   failure → 3 s flat cooldown in the failed pool
   (`FAILED_INTENTION_RETRY_MS`). On corridor maps this serially blocks every
   delivery attempt.
3. **Deliveries are filtered out of the queue when their score ≤ 0.**
   `sortQueueByScore` keeps only `score > 0` entries
   (`bdi/bdiAgent.js:189`). The drop-off score is
   `totalReward − estimatedLoss` (`bdi/bdiAgent.js:139-152`): when carrying
   low-value parcels far from a delivery, the score is ≤ 0 and the delivery
   intention is silently erased — the agent keeps the parcels until they decay
   to nothing.
4. **Preemption thrashing.** Every sensing event — including every decay tick
   of any visible parcel, which the server emits as a parcel change — fires
   `optionsGeneration` → `push` → `sortQueueByScore`, and any intention that
   scores even 0.001 above the running delivery preempts it
   (`bdi/bdiAgent.js:200-204`). Near a parcel-dense area, deliveries get
   preempted over and over within a few tiles of the delivery tile.

Additionally `GO_TO_TIMEOUT_MS = 5000` is a flat timeout independent of path
length: on slow-movement configs a perfectly healthy long delivery leg can
time out.

### S3. No awareness of crowded zones (high agents/parcels ratio)

`intentionScore` and `generatePickupOptions` use only the parcel's reward and
the agent's own distance. `bs.agents` is maintained (`updateBeliefs.js:114-124`)
but never consulted when valuing a pickup. In a contested zone the agent
repeatedly races (and loses) against closer opponents, paying travel cost for
parcels it never gets.

### S4. Wall-clock-based expected reward is server-dependent

`distanceFactor` = `PARCEL_DECAY / tilesPerSecond` where `tilesPerSecond` is
*measured* with `Date.now()` over a 10 s moving window
(`utils/mapUtils.js:34-76`), seeded with an absurd default of **10.0 tiles/s**,
and `PARCEL_DECAY = 1/s` is a constant fallback. Server lag, frame stutter,
pauses between intentions and the warm-up window all corrupt the estimate.
Meanwhile the server *declares* the true rates in its config —
`movement_duration` and `parcels.decaying_event` are already saved into
`bs.config` (`beliefs/updateBeliefs.js:23-34`) — but the BDI scoring never
uses them (only the LLM-side `stateUtils.getRewardLossPerTile` partially
does, and it still mixes in the measured speed).

### S5. Hoarding: agent keeps picking up and never delivers (0 points)

Compare the two scores in `intentionScore`:

- drop-off: `totalReward − estimatedLoss − DROP_DISINCENTIVE` with
  `DROP_DISINCENTIVE = 0`
- pickup: `totalReward + newParcel.reward − routeDist·factor − estimatedLoss`

A pickup beats the best delivery whenever
`newParcel.reward > routeDist·factor + Δloss` — i.e. whenever *any* visible
parcel is worth marginally more than the cost of walking to it. With infinite
sensing or dense spawn zones such a parcel **always** exists, so delivery is
postponed forever — exactly the observed behavior. (More precisely — see
WP6.2 — the score difference *does* contain a rising per-carried-parcel bar
`n·f·(R−D)`, but it is neutered by the broken `distanceFactor` of S4.) There
is no capacity awareness (`bs.config.playerCapacity` is stored but unused)
and no banking guarantee when decay is off.

---

## Part 2 — Improvement plan (work packages)

Ordered by expected impact / effort ratio. None touches the skeleton: WP1 is
in `beliefs/`, WP2 in `actions/` + `pathfinding/`, WP3–WP6 are changes to the
*content* of `intentionScore`, `sortQueueByScore`'s comparison rule,
`optionsGeneration` and the failure pool — all existing extension points.

### WP1 — Belief persistence (parcel & agent memory) → fixes S1

**Change** (`beliefs/updateBeliefs.js`, `beliefs/beliefState.js`):

- Delete a known parcel only on **negative evidence**: its believed position
  is inside the currently observable area (use `sensing.positions`, which the
  server already sends, or fall back to a Manhattan/`observationDistance`
  test) **and** it is absent from the snapshot — meaning it was picked up,
  delivered or expired. A parcel that merely left the sensing range is kept.
- For each retained out-of-view parcel, store `lastSeenAt` (or better, a
  decay-event counter) and decay its believed `reward` locally at the
  server-declared rate (WP5). Evict when the estimated reward reaches 0 or a
  TTL expires (e.g. 2× the time needed to cross the map), since an unseen
  parcel may have been taken by someone else.
- Apply the same policy to `bs.agents` but with a much shorter TTL (agents
  move fast; remember last-seen position ~2–3 s, used by WP2 soft obstacles
  and WP4 congestion estimates), instead of today's "delete on first missed
  snapshot".

**Effect on the loop**: the validity check in `bdiAgent.js:233-241` keeps
working unchanged — the parcel simply stays in beliefs, so heading towards a
border parcel no longer self-destructs the intention. The score of remembered
parcels naturally degrades (decayed reward, growing distance), so stale
beliefs lose competitions without special-casing.

### WP2 — Robust execution & failure handling → fixes S2 (causes 1, 2) 

**Change** (`actions/actions.js`, `pathfinding/`, failure pool in
`bdiAgent.js`):

1. **Retry-then-replan on blocked steps.** In `executePath`, when `move()`
   fails: wait `MOVEMENT_RETRY_DELAY_MS` (finally using it) and retry the same
   step up to ~3 times (transient crossing agent); if still blocked,
   **recompute the path from the current position** (the blocker is now in
   `bs.agents`, so the new path routes around it); only after `N` consecutive
   replans (e.g. 3) fail the intention. This single change converts most
   delivery failures into 100–300 ms hiccups.
2. **Soft obstacles.** In pathfinding, treat an agent-occupied tile as *hard*
   blocked only within a small radius of the start (e.g. ≤ 2 tiles — it is
   actually in the way now); farther agents become a *penalty cost* on the
   tile in A* (they will have moved by the time we arrive). Switch
   `AGENT_CONFIG.pathfinding.algorithm` to `astar` (the cost machinery is
   already there: `BASE_STEP_COST`/`MIN_EDGE_COST`). This eliminates the
   "Path not found because someone stands in the corridor 12 tiles away"
   failure class.
3. **Path-proportional timeout.** Replace the flat `GO_TO_TIMEOUT_MS` with
   `path.length × movementDuration × safetyFactor (≈3)` so long legs don't
   spuriously time out and short legs fail fast.
4. **Smarter failure pool.** Two orthogonal mechanisms: the backoff governs
   *the failed target itself*, the fallback governs *what the agent does in
   the meantime*. The pool is keyed by the full predicate, so the backoff
   applies uniformly to pickups and dropoffs — each failed predicate gets its
   own counter and cooldown.
   (a) **Exponential backoff per predicate key** (3 s → 6 s → 12 s, capped
   ~30 s) instead of flat 3 s, so genuinely unreachable targets stop being
   hammered while transient blocks recover quickly. The failure count must
   live *outside* the cooldown entry (a separate `key → {failures,
   lastFailureAt}` map), since the cooldown entry is deleted on requeue;
   reset the counter on success or after a long quiet period (~60 s). With
   retry-then-replan (point 1) most transient blocks never reach the pool —
   it becomes the rare-case last resort, exactly when backoff is right.
   (b) **Immediate alternative target.** On a `go_drop_off` failure, push the
   delivery option for the **next-nearest delivery tile** right away (options
   for all tiles already exist in `generateDeliveryOptions`); it enters the
   queue and competes by score normally — the point is only that the queue
   must never be empty of deliveries during a cooldown. Delivery-specific by
   design: a failed pickup already competes against the other queued parcels
   regenerated on every belief update (only the failed parcel's key is
   filtered), while a failed delivery leaves the agent with no delivery
   option at all. No stale-intention risk: if the agent banks at the fallback
   tile, the requeued original is discarded by the existing carrying check.

### WP3 — Commitment with hysteresis (intention reconsideration policy) → fixes S2 (cause 4)

**Change** (`sortQueueByScore` preemption rule, `bdiAgent.js:200-204`):

- Preempt the running intention only if
  `challengerScore > currentScore × (1 + H) + ε` with `H ≈ 0.2–0.3`. Equal or
  marginally-better options no longer interrupt committed work.
- No special "final approach" rule for `go_drop_off`: hysteresis alone covers
  it, because the drop score `V − n·D·f` is *maximal* exactly in final
  approach (D → 0 makes it ≈ V), so a challenger must beat ~`V × (1+H) + ε`
  — which essentially never happens two tiles from the tile. One rule, no
  special cases; revisit only if testing still shows late-stage preemption.
- Rate-limit reconsideration: run the full re-sort on *significant* belief
  changes (new parcel appeared, a tracked parcel vanished, carried set
  changed, an intention ended) or at most every ~200–300 ms — not on every
  decay tick of every visible parcel. Cheap to implement as a dirty-flag +
  minimum interval inside `optionsGeneration`/`push`; the skeleton is
  untouched.

This is the classic bold-vs-cautious commitment trade-off (see report §3):
the current agent is maximally cautious in a fast environment where
reconsideration is nearly free but *acting on* reconsideration (abandoning a
half-completed route) is expensive.

### WP4 — Congestion-aware pickup scoring → addresses S3

**Change** (`generatePickupOptions` / `intentionScore` for `go_pick_up`):

- **Race discount.** For each candidate parcel, compute
  `oppDist = min` distance of any known agent (from WP1's agent memory) to
  the parcel and `myDist` = my route distance. Scale the parcel's expected
  reward by a win-probability estimate, e.g.
  `P(win) = 1 / (1 + e^{(myDist − oppDist)/τ})` (τ ≈ 2 tiles), or the cheaper
  step function: full value if `myDist < oppDist`, ×0.5 if comparable,
  ×0.1 if an opponent is strictly closer.
- **Zone density penalty.** Around each candidate parcel, count agents `A`
  and free parcels `P` within radius `r` (≈ observation distance / 2) and
  multiply the score by `min(1, P / (A + 1))`. Zones where competitors
  outnumber parcels become unattractive; zones with many parcels per agent
  stay attractive (they amortize the travel). Same signal can be added to
  exploration target choice in `findCellsToExplore` later.

Both are pure score modifiers — option generation and the queue mechanism are
unchanged. Expected effect: the agent stops paying travel cost for parcels it
statistically never wins, and drifts towards underserved areas.

### WP5 — Event-based decay model (no wall clock anywhere) → fixes S4

**Change** (`distanceFactor` in `bdi/options.js`, decay-tick counting in
`beliefs/updateBeliefs.js`, per-step sampling in `actions/actions.js`):

The quantity every score needs is one number — `decayPerStep` = reward
points lost per tile of travel, per carried parcel. Estimate it **purely
from server events**, using the parcels' own rewards as the clock:

- **Observation.** Every server decay tick is visible as a `−1` on sensed
  parcels' rewards in the parcel-sensing snapshot, and every completed step
  is visible as a move acknowledgment. Both are server-emitted events. In
  the belief update, accumulate observed per-parcel reward decrements into a
  global tick counter; in `executePath`, between two **consecutive move-acks
  of the same path**, read how many ticks landed in the window — that delta
  *is* a direct sample of decay-per-step. Feed samples into an exponential
  moving average.
- **Why this dominates the alternatives.** It automatically prices in every
  slowness source — client computation, network round-trips, retries,
  congestion — because a longer step necessarily contains more ticks, by
  definition. Server lag cancels (slow server = fewer ticks *and* slower
  acks). Idle/deliberation time cannot poison it because only windows
  between consecutive acks inside a running path are counted. The previous
  wall-clock approach (measured `tilesPerSecond`) is removed from the
  scoring path entirely: it injected client jitter into every score and had
  a deadlock failure mode (idle agent → measured speed ~0 → `f` explodes →
  every option scores negative → agent stays idle).
- **Warm-up prior.** Seed the EMA from config:
  `decayPerStep₀ = movement_duration / decayInterval_ms`, both already in
  `bs.config` from `socket.onConfig`. Rewards are integers, so single
  windows read 0 or 1 — the estimate firms up over ~10–20 steps; the prior
  covers the start.
- **No decay.** `decaying_event: 'infinite'` → `decayPerStep = 0`, no EMA
  updates needed (no decrements will ever be observed). Decision weight
  shifts to WP6's capacity/cap triggers, which is correct: with no decay,
  distance no longer penalizes hoarding — the delivery trigger must.

### WP6 — Explicit delivery-trigger policy (anti-hoarding) → fixes S5

**Change** (`intentionScore` + a small check in `optionsGeneration`):

Three complementary triggers, each cheap:

1. **Capacity trigger.** If `carriedCount ≥ bs.config.playerCapacity`,
   pickups score `−1` (invalid) — delivery becomes the only scored option.
   Today capacity is ignored and pickups on a full agent waste time.
2. **Value-at-risk — already implicit in the score; no new trigger.**
   Checking the algebra of `intentionScore` (ignoring the `min` caps), with
   `n` carried parcels of total value `V`, drop distance `D`, pickup full
   route `R`: drop-off scores `V − n·D·f`, pickup scores
   `V + r − R·f − n·R·f`, so pickup wins iff `r > R·f + n·f·(R − D)`. The
   term `n·f·(R − D)` *is* the delivery-postponement cost: every carried
   parcel pays `f` per tile of detour, so the bar for the next pickup
   already rises with the carried count — which matches the true decay
   physics (each parcel loses 1 point per decay event regardless of value).
   The two `estimatedLoss` terms do **not** cancel: they use different
   distances (`R` vs `D`). The observed hoarding is caused by `f` being
   numerically broken (S4: seeded at 10 tiles/s → `f ≈ 0.1`, flattening the
   bar), so the fix is WP5, not a new term. What *does* need fixing here:
   the `score > 0` filter in `sortQueueByScore`. With the caps, the drop
   score is `Σ max(0, rᵢ − D·f) ≥ 0`, hitting exactly 0 when every carried
   parcel would die en route — the delivery is then erased and the agent
   carries worthless parcels forever. Always keep the best delivery option
   whenever carrying, even at score 0.
3. **No-decay guard: hard cap at `min(10, capacity)` carried parcels.** When
   `decayPerStep = 0` the rising bar of point 2 vanishes
   (`pickup − drop = r > 0` always) and only a hard threshold guarantees the
   agent ever banks. The cap is deliberately generous: on maps with spawn
   areas far from delivery, the winning strategy is to camp the spawn
   cluster and amortize the long round-trip over many parcels (a round trip
   costs ~2·D steps regardless of load), so a small fixed K would force
   premature trips and lose to campers. 10 covers the large majority of
   situations; when the server declares a smaller capacity, trigger 1 fires
   first anyway. Known accepted limitation: end-of-match unbanked parcels.
4. **(Optional, cheap win) Opportunistic actions.** While executing any
   `go_*` route: if the current tile is a delivery tile and we carry parcels →
   `putdown`; if a free parcel sits on the current tile and we're under
   capacity → `pickup`. Zero detour, handled inside `executePath`'s `onStep`
   hook which already exists.

### Suggested order & validation

| Order | WP | Why first |
|---|---|---|
| 1 | WP5 | tiny, makes every other score change measurable & reproducible |
| 2 | WP1 | unblocks S1; prerequisite for WP4's opponent memory |
| 3 | WP2 | biggest single win on delivered points (S2) |
| 4 | WP6 | guarantees non-zero score in dense/infinite-sensing maps |
| 5 | WP3 | stabilizes behavior; tune H after WP6 changes score landscape |
| 6 | WP4 | multi-agent refinement on top of a now-stable baseline |

*(Secondary — deprioritized for now; revisit only when tuning.)*
Metrics to log per run (all derivable from existing events):
**points/minute**, **deliveries/minute**, **mean carry time per parcel**,
**% intentions failed by cause** (path-not-found / move-blocked / timeout /
preempted), **pickup races lost** (parcel vanished while en route). Test
matrix: {corridor map, open map} × {2, 6 agents} × {decay on, decay off} ×
{limited, infinite sensing}. WP6 success criterion: zero runs with 0 points
under infinite sensing; WP2 criterion: delivery failure rate < 5%.

---

## Part 3 — Report: justification and state of the art

### 1. Belief persistence (WP1)

Deleting unseen-but-not-disproven facts violates the standard treatment of
perception in agent architectures: beliefs should persist until *contradicted*
by observation, not until they merely stop being refreshed. In robotics this
is the **anchoring / object permanence** problem (Coradeschi & Saffiotti,
"An introduction to the anchoring problem", 2003): an anchor to a no-longer-
perceived object is kept alive with a predicted state and a confidence that
decays over time — exactly the proposed `lastSeen + locally-decayed reward +
TTL` scheme. Partially observable formulations (POMDPs) make the same point
formally: the belief state integrates observations over time; the current
implementation collapses the belief to the last observation. The TTL and
reward-decay terms are the cheap, principled stand-in for the growing
uncertainty that a full Bayesian treatment would track.

### 2. Robust execution in dynamic environments (WP2)

Treating mobile agents as static hard obstacles is known to be both incorrect
and brittle; the literature on pathfinding among moving agents either
replans incrementally — **D\* Lite** (Koenig & Likhachev, AAAI 2002) repairs
the plan when the world changes instead of failing — or reasons about other
agents only within a short time horizon — **WHCA\*** (Silver, "Cooperative
Pathfinding", AIIDE 2005) observes that beyond a small window other agents'
positions carry no information. The proposed "hard-block near, penalty far,
replan on contact" is the standard lightweight approximation of both ideas
for single-agent settings without coordination. Exponential backoff for
failed targets is the textbook treatment for transient-vs-persistent fault
disambiguation. The expected-impact claim is mechanical: today one blocked
step costs a full intention + 3 s cooldown + re-pathing from scratch; with
retry-then-replan it costs ~tens of milliseconds.

### 3. Commitment and intention reconsideration (WP3)

This is the most studied dial in BDI theory. Intentions are *conduct
controllers* that should resist reconsideration (Bratman 1987; Cohen &
Levesque, "Intention is choice with commitment", AIJ 1990). **Kinny &
Georgeff** ("Commitment and effectiveness of situated agents", IJCAI 1991)
showed experimentally that *bold* agents (which reconsider rarely) outperform
*cautious* ones whenever reconsideration — or acting on it — has a cost, even
in fairly dynamic worlds; **Schut & Wooldridge** ("Principles of intention
reconsideration", AGENTS 2001; and the meta-level control follow-ups) frame
the optimal policy as reconsidering only when the expected value of changing
intention exceeds the cost. The current agent is pathologically cautious:
it reconsiders on every parcel decay tick and switches on an ε improvement,
paying the (large, in walked tiles) switching cost every time. The hysteresis
threshold `H` is a direct, tunable implementation of bounded-rational
reconsideration (it also naturally protects deliveries in final approach,
where the drop score peaks); keeping
preemption available above the threshold preserves open-mindedness
(single-minded commitment with an escape hatch).

### 4. Competition-aware task valuation (WP4)

In the multi-robot task-allocation taxonomy (**Gerkey & Matarić**, IJRR 2004)
this game is online ST-SR-IA allocation, but with *non-cooperating*
competitors, so coordination mechanisms — auctions/market-based allocation
(Dias, Zlot, Kalra, Stentz, Proc. IEEE 2006) or **CBBA** (Choi, Brunet & How,
IEEE T-RO 2009) — don't apply directly; their underlying principle does:
a task's value to an agent is its *expected* marginal utility, which must
include the probability of actually obtaining it. Discounting a parcel by a
distance-race win probability is the degenerate (no-communication) form of a
bid: when an opponent is strictly closer, the expected value of racing is
near zero and the rational bid is to not race. The zone-density penalty is
the same idea aggregated spatially, and parallels density-based dispatch
heuristics in ride-hailing/fleet management (drivers repositioning towards
high demand-to-supply ratio zones), a well-documented effective heuristic in
dynamic fleet literature.

### 5. Event-based time model (WP5)

The decay process and the movement process are both *server-side
discrete-event processes* driven by the same clock. Expressing their ratio in
the server's own declared units (`movement_duration` / `decaying_event`)
makes the score a dimensionless, lag-invariant quantity — if the server slows
down, both processes slow identically and the ratio is preserved. Measuring
either side with the client's wall clock injects network jitter and
client-side scheduling noise into every decision, which is exactly the
observed "server-dependent" behavior. This is the basic discipline of
discrete-event simulation: never mix simulation time with wall-clock time.
The measured speed remains useful only to detect a *real* discrepancy
(movement penalties, congestion) as a bounded correction factor.

### 6. Delivery triggering / anti-hoarding (WP6)

The single-agent core of Deliveroo is an online **prize-collecting routing
problem with time-decaying prizes** — a dynamic variant of the Orienteering
Problem (Golden, Levy & Vohra 1987; survey: Vansteenwegen, Souffriau & Van
Oudheusden, EJOR 2011) and of dynamic pickup-and-delivery problems
(Berbeglia, Cordeau & Laporte, EJOR 2010; dynamic VRP survey: Pillac et al.,
EJOR 2013). Two structural facts from that literature justify the triggers:

- With decaying prizes, the value of a *tour* is concave in its length: each
  added pickup delays the banking of **all** already-collected prizes, so the
  marginal value of the k-th pickup decreases in k and in carried value. The
  implemented score already contains this delay term via its `estimatedLoss`
  over the full pickup route (see WP6.2) — it is neutered only by the broken
  time model (S4), which is why the agent behaves greedy-myopic and hoards
  in practice. WP5 restores the term's numerical meaning.
- Online routing policies need an explicit **commitment/banking rule** to be
  competitive: cheapest-insertion-style policies in dynamic PDP commit
  requests to routes and *close* routes; threshold policies (deliver when
  load ≥ C or value-at-risk ≥ α·V) are the standard simple form and are
  near-optimal when request arrival is stationary — which Deliveroo's
  constant-rate parcel spawner satisfies. The no-decay guard (trigger 3) is
  needed precisely because when prizes don't decay the concavity argument
  vanishes and *only* a hard threshold guarantees the agent ever banks —
  matching the observed 0-point runs under infinite sensing.

The capacity trigger is not heuristic at all — it reads a hard game
constraint (`player.capacity`) that the agent currently ignores.

### 7. Why nothing in the skeleton needs to change

Every fix lands in a designed extension point of the existing architecture:
belief revision (`updateBeliefs`), desire/option generation
(`optionsGeneration`), the utility function (`intentionScore`), the filter
(`sortQueueByScore`'s comparison and the preemption guard), means-ends
execution (`executePredicate` and below), and failure recovery (the failed
pool). This is the canonical BDI interpreter decomposition (Rao & Georgeff,
"BDI agents: from theory to practice", ICMAS 1995): the *control loop* stays
fixed; behavior quality lives in the functions the loop calls. The plan
deliberately exploits that separation.

---

## Part 4 — Latest iteration: implemented refinements

Three issues surfaced once the agent was running. All fixes plug into the
existing layers — no BDI skeleton change, same as WP1–WP6.

### S6 — Route ping-pong

**Problem.** At a junction with two blocked corridors and a longer open one,
the agent bounced between the two blocked routes forever and never took the
long one. `goTo` replanned from scratch each time with no memory of where it
had just been blocked, so it kept re-picking whichever short route looked
momentarily cheaper.

**Fix — WP7 (reroute with blocked-tile memory).** A refused move now tags the
tile it couldn't enter (`move` → `error.blockedTile`). `goTo` collects these
across replans into an `avoidTiles` set and hard-blocks them in A*
(`astar.js`). Once both short chokes are remembered, only the long route
remains and gets taken. If avoiding leaves no path at all, `goTo` drops the set
and retries the choke (better to wait than to fail). `MAX_REPLANS` 3 → 6, since
replans now converge instead of thrash.
Regression test: `pathfinding/astar.reroute.test.mjs`.

### S7 — Mirroring deadlock

**Problem.** Two agents stepping the same way block each other in lockstep;
rerouting alone doesn't help because both reroute identically.

**Fix — WP8 (yield with random backoff).** In `executePath`, when the blocking
tile holds another *agent* (not a wall/crate), the agent waits a **random**
short interval and retries in place (`YIELD_*` constants), a few times before
giving up to the reroute. The randomness breaks the symmetry so one slips
through while the other waits.

### S8 — Leaving productive pockets

**Problem.** When idle, the agent ran off to explore the instant its view
emptied, abandoning a dense pocket that was about to refill.

**Fix — WP9 (camp).** On by default (`AGENT_CONFIG.behavior.camp`; disable with
`CAMP=false`). When idle near where parcels appear, the agent stays and patrols
the pocket instead of wandering.

- **Where to camp:** the last place it saw a free parcel (`lastParcelHint`, set
  from sensing in `updateBeliefs`). Camp only runs once a parcel has been seen.
- **Patrol, don't freeze:** it loops the spawn tiles within `CAMP_PATROL_RADIUS`
  of the anchor, keeping the whole pocket in view so each respawn is grabbed at
  once.
- **Camp and explore stay separate intentions:** the `camp` action only
  patrols — it never explores or delivers itself. A scoring gate makes camp
  valid only while the pocket is *hot*; when it goes cold the scorer hands off
  to a normal `explore` intention (empty-handed) or to delivery (carrying), and
  back to camp when a parcel is seen again. To make that hand-off fire on time,
  `onUpdate` now re-sorts the queue every reconsideration tick (not only when
  the option set changes), still rate-limited and hysteresis-guarded per WP3.
- **How long to wait (adaptive):** patience grows with how clustered the spawn
  tiles are around the pocket —

      patience = clamp(1000 × (1.6^(greenTiles − 1) − 1), 0, 8000) ms

  0 for a lone tile (not worth it → explore), rising to the 8 s cap at ~6
  clustered tiles. Green-tile counts come from the **static map** (the full
  spawn layout is known from the start), not sensing. The spawn *rate* is not
  used — a slow map would wrongly camp longest; `generation: infinite` just
  disables camping.
- **Camp while carrying (budgeted):** the agent may keep gathering before
  delivering, but only while cheap. Decay off → fill up to capacity for free;
  decay on → a 5 % loss budget (`CAMP_LOSS_BUDGET_FRACTION`, tracked in
  `bs.carry.campSteps`) caps how much reward it bleeds first. At capacity or
  budget spent → deliver.

### Why these are sound (extends Part 3)

- **WP7** — `avoidTiles` is a short-lived **tabu list** (Glover, "Tabu Search",
  1989) that stops the greedy planner re-entering a just-blocked move; it adds
  the memory that makes the WP2 "replan on contact" idea converge instead of
  oscillate.
- **WP8** — **randomized backoff** to break phase-lock, as in Ethernet CSMA/CD
  (Metcalfe & Boggs, 1976). Randomness is the right tool because the blocker is
  a non-cooperating opponent that won't honor a shared priority rule.
- **WP9** — **patch residence** from optimal foraging (Charnov's Marginal Value
  Theorem, 1976): stay in a patch while it pays, leave when it doesn't. The
  adaptive patience is the giving-up time, scaled by how rich the patch is.
