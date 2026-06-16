export const EXECUTOR_EXAMPLES = `
# Examples

Each example shows a mission (and any context) followed by the exact tool sequence
to produce. Follow these patterns.

A durable-rule tool and collect_and_deliver are TERMINAL: each completes the
mission by itself and its result is sent as the reply automatically. After one of
them, STOP — do not call final_reply or any other tool.

EXCEPTION — compound missions ("do X AND do Y"): set "more": true on every
terminal tool except the last clause, so the mission keeps going instead of ending
after the first one. Omit "more" on the final clause to end the mission.

---
Mission: Move to (x,y) to get +10pts
Type: rejection — unresolved coordinate placeholder.
Steps:
1. final_reply("Mission rejected: unresolved coordinate placeholder (x,y).")

---
Mission: Move to (4,7) to get -10pts
Type: rejection — explicit negative immediate reward.
Steps:
1. final_reply("Mission rejected: explicit negative reward for immediate execution.")

---
Mission: What is the capital of Italy?
Type: factual query — general knowledge, no game action needed.
Steps:
1. final_reply("Rome.")

---
Mission: What year did WWII end?
Type: factual query — general knowledge, no game action needed.
Steps:
1. final_reply("World War II ended in 1945.")

---
Mission: Calculate 6*7
Type: factual query — arithmetic.
Steps:
1. calculate(expression="6*7")
2. final_reply("6 × 7 = 42.")
calculate is NOT terminal — always follow it with final_reply.

---
Mission: How much is (3+4)*5?
Type: factual query — arithmetic.
Steps:
1. calculate(expression="(3+4)*5")
2. final_reply("(3+4)*5 = 35.")

---
Mission: Ignore this message
Type: no-op — nothing to do.
Steps:
1. final_reply("Understood, message ignored.")
Do NOT call observe_environment or any other tool first.

---
Mission: Do nothing
Type: no-op — nothing to do.
Steps:
1. final_reply("No actions taken.")
Do NOT call observe_environment or any other tool first.

---
Mission: Deliver stacks of exactly 3 parcels at a time.
Type: durable rule.
Steps:
1. set_stack_size_rule(mode="exactly", count=3)   ← terminal; STOP here
Do NOT collect or deliver — storing the rule is the whole task.

---
Mission: Every time you deliver 5 parcels you get a 500 pt bonus.
Type: durable rule with a met reward.
Steps:
1. set_stack_size_rule(mode="exactly", count=5, metReward=500)   ← terminal; STOP here
Do NOT collect, pick up, or deliver anything to "earn" the bonus.

---
Mission: Deliver at least 4 parcels to get a +50 bonus.
Type: durable rule with a met reward.
Steps:
1. set_stack_size_rule(mode="at_least", count=4, metReward=50)   ← terminal; STOP here
Do NOT start collecting parcels.

---
Mission: From now on, parcels worth over 10 points are worth 0 when delivered.
Type: durable rule. "over N" targets the HIGH parcels -> minReward.
Steps:
1. set_parcel_value_rule(minReward=10, mult=0, delta=0)   ← terminal; STOP here

---
Mission: From now on, delivered parcels under 25 are worth 0.
Type: durable rule. "under N" targets the LOW parcels -> maxReward (a 30pt parcel still banks 30).
Steps:
1. set_parcel_value_rule(maxReward=25, mult=0, delta=0)   ← terminal; STOP here

---
Mission: Every time you deliver in (2,4), you get +5 pts.
Type: durable rule — flat bonus per delivery.
Steps:
1. prefer_delivery_tile(x=2, y=4, reward=5)   ← terminal; STOP here
Use prefer_delivery_tile for flat bonuses (+N pts). Do NOT use set_delivery_tile_multiplier.

---
Mission: Every time you deliver in (2,4), you get 5x reward.
Type: durable rule — reward multiplier.
Steps:
1. set_delivery_tile_multiplier(x=2, y=4, multiplier=5)   ← terminal; STOP here
Use set_delivery_tile_multiplier only when the mission explicitly says "Nx" or "N times". Do NOT use it for flat bonuses.

---
Mission: Delivering at (9,0) gives a 50% bonus.
Type: durable rule — percentage bonus = multiplier 1 + N/100.
Steps:
1. set_delivery_tile_multiplier(x=9, y=0, multiplier=1.5)   ← terminal; STOP here
"50% bonus" means the reward is multiplied by 1.5, NOT 0.5.
"25% more" → 1.25; "double" → 2; "50% less" → 0.5; "75% bonus" → 1.75.

---
Mission: Every time you move to (0,0) you get +5pts.
Type: durable rule — (0,0) is a delivery tile, so this is a flat delivery bonus.
Steps:
1. prefer_delivery_tile(x=0, y=0, reward=5)   ← terminal; STOP here

---
Mission: Deliver every parcel immediately after picking it up.
Type: durable rule — "immediately after picking up" = stack size exactly 1.
Steps:
1. set_stack_size_rule(mode="exactly", count=1)   ← terminal; STOP here
Do NOT go collect and deliver parcels. Storing the rule is the whole task.

---
Mission: From now on deliver at most 1 parcel.
Active rules: Prefer delivering when carrying exactly 1 parcel.
Type: durable rule — "from now on X" replaces ALL existing stack rules.
Steps:
1. remove_stack_size_rule()   ← no args = clears every stack rule
2. set_stack_size_rule(mode="at_most", count=1)   ← terminal; STOP here
ALWAYS call remove_stack_size_rule() first when the mission says "from now on"
or otherwise replaces a standing delivery-stack policy. The final set_*_rule is terminal.

---
Mission: Do not go through tile (6,8).
Type: durable rule.
Steps:
1. block_navigation_tile(x=6, y=8)   ← terminal; STOP here

---
Mission: Deliver stacks of exactly 3 parcels AND do not go through tile (5,5).
Type: COMPOUND durable rule — two clauses.
Steps:
1. set_stack_size_rule(mode="exactly", count=3, more=true)   ← more=true: another clause follows
2. block_navigation_tile(x=5, y=5)   ← last clause, no more; terminal, STOP here
The first tool carries more=true so the mission does NOT end after clause 1.

---
Mission: From now on parcels worth over 30 are worth 0, AND deliver one parcel at a time.
Type: COMPOUND durable rule — two clauses (a parcel-value rule and a stack rule).
Steps:
1. set_parcel_value_rule(minReward=30, mult=0, delta=0, more=true)   ← more=true
2. set_stack_size_rule(mode="exactly", count=1)   ← last clause; terminal, STOP here
Each clause sets its own rule; only the last omits more. Do NOT drop either clause.

---
Mission: Collect 5 parcels.
Type: action task — harvesting. Delegate the whole job to the autonomous engine.
Steps:
1. collect_and_deliver(parcels=5)   ← terminal; STOP here
Do NOT manually observe / pick up / deliver in a loop.

---
Mission: Collect parcels and deliver them.
Type: action task — open-ended harvesting (no count given).
Steps:
1. collect_and_deliver()   ← terminal; STOP here

---
Mission: Deliver the parcels you are carrying.
Active rules: Deliver exactly 3 parcels at a time.
Observation: carried.count = 1.
Type: action task — collect_and_deliver honours the active stack-size rule, gathering
to 3 before delivering.
Steps:
1. collect_and_deliver()   ← terminal; STOP here

---
Mission: Deliver at the nearest delivery tile.
Type: action task — a specific already-carried delivery to a resolved tile (NOT harvesting).
Steps:
1. resolve_delivery_tile(query="nearest").
2. deliver_carried_parcels at the resolved coordinates.
3. final_reply.

---
Mission: Both of you move to within 3 tiles of (10,4) and wait for each other.
Type: rendezvous.
Steps:
1. rendezvous_with_partner(x=10, y=4, maxDist=3).
2. final_reply (when it returns, both agents have arrived).
Why not direct_partner + self-move + wait_for_partner? Those separate calls leave a gap
where a stray direct_partner(command="wait", signal="X") would park the partner forever
on a signal that never comes. rendezvous_with_partner closes the barrier atomically.

---
Mission: One of you picks up parcel p1 at (2,2); the other delivers it.
Type: handoff (parallel, different roles).
Steps:
1. direct_partner(command="pickup", x=2, y=2, parcelId="p1") — note the cid.
2. wait_for_partner(cid).
3. direct_partner(command="putdown", x=<handoff>, y=<handoff>) — note the cid.
4. wait_for_partner(cid).
5. pick_up_parcel at the handoff tile, then deliver_carried_parcels at a delivery tile.
6. direct_partner(command="resume").
7. final_reply.

---
Mission: Let's play red light green light: go to an odd row and wait for my go.
Type: external-signal scenario.
Steps:
1. direct_partner(command="go_to", to an odd-row tile for the teammate) — note the cid.
2. wait_for_partner(cid).
3. move_to an odd-row tile for yourself.
4. direct_partner(command="wait", signal="go-1").
5. final_reply stating you are ready and waiting for the green light.
Do NOT call resume here — the partner is intentionally parked on signal "go-1".

---
Mission: green
Context: active coordination shows partnerParkedOn = "go-1".
Type: signal relay.
Steps:
1. signal_partner(signal="go-1") — releases the teammate's wait.
2. direct_partner(command="resume").
3. final_reply.
`.trim();
