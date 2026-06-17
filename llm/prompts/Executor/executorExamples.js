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
Mission: Move to (4,7) to get +10pts
Type: action task — movement with positive reward. Reward is the motivation, not a reason to reject.
Steps:
1. move_to(x=4, y=7)
2. final_reply("Arrived at (4,7).")
A positive "+N pts" is NOT a negative reward — do NOT reject it. Proceed to move_to.

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
Type: durable rule — explicit "from now on" full reset.
Steps:
1. remove_stack_size_rule(more=true)   ← more=true so the mission does NOT end here
2. set_stack_size_rule(mode="at_most", count=1)   ← last step; terminal, STOP here
The remove MUST carry more=true, otherwise the mission ends on the removal and the new
rule is never stored. For a plain new stack rule (no "from now on" / "forget"), skip the
remove entirely — set_stack_size_rule already replaces any contradicting stack rule.

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
Mission: Drop a package at the leftmost delivery tile to get 5pt.
Observation: carried.count = 0, visibleParcels = [].
Type: action task — a specific delivery to a resolved tile (NOT harvesting), but you are
not carrying anything yet and none is visible right now.
Steps:
1. resolve_delivery_tile(query="leftmost").
2. observe_environment — re-check; a parcel can appear or come into view.
3. If still none visible: move_to a few tiles toward the middle of the map (or toward
   wherever parcels were last seen) and observe_environment again. Repeat a few times.
4. As soon as one parcel is visible: pick_up_parcel at its coordinates.
5. deliver_carried_parcels at the tile resolved in step 1.
6. final_reply.
Do NOT conclude "no package to drop" after a single empty check — the rejection
whitelist does not include "nothing visible right now", and observe_environment /
move_to cost nothing to retry. Do NOT call collect_and_deliver instead: it picks its
own delivery tile and may bank far more than "a package", so it would not satisfy
"at the leftmost tile" even though it reports success.

---
Mission: Both of you move to within 3 tiles of (10,4) and wait for each other.
Type: rendezvous.
Steps:
1. rendezvous_with_partner(x=10, y=4, maxDist=3)   ← terminal; STOP here
Do NOT add a final_reply: rendezvous_with_partner is terminal and its own result is
the reply. Emitting a separate final_reply only costs an extra round-trip after the
agents have already met. (Only continue if the mission has a further clause — then set
more=true on this call.)
Why not direct_partner + self-move + wait_for_partner? Those separate calls leave a gap
where a stray direct_partner(command="wait", signal="X") would park the partner forever
on a signal that never comes. rendezvous_with_partner closes the barrier atomically.

---
Mission: Go together in the neighborhood of (2,2) and wait for my signal to move.
Type: COMPOUND coordination — rendezvous (clause 1) THEN hold for an external/operator
signal (clause 2). "wait for MY signal" is an external signal, distinct from a plain
"wait for each other" rendezvous. rendezvous_with_partner RELEASES the teammate on
arrival, so it must NOT be the last step here.
Steps:
1. rendezvous_with_partner(x=2, y=2, maxDist=1, more=true)   ← more=true: a wait clause follows
2. direct_partner(command="wait", signal="go")   ← park the teammate until the signal
3. final_reply stating both are near (2,2) and waiting for the signal to move.
Do NOT call resume — the teammate must stay parked. A later "go"/"green" mission relays
the signal (see the signal-relay example). Dropping step 2 (calling only
rendezvous_with_partner and stopping) is the bug to avoid: the partner then wanders off
after the rendezvous instead of waiting.

---
Mission: If a parcel is initially picked up by one agent and later delivered by the other agent, you will receive a 200 points bonus.
Type: cross-delivery HANDOFF task (NOT a durable rule). The "if ... +200" wording
describes a coordination achievement to perform now, not a scoring rule — never
store it as a stack-size rule.
Steps:
1. handoff_to_partner()   ← terminal; STOP here
The teammate self-selects a parcel it can reach, drops it, and you collect and
deliver it — all in one atomic step. Do NOT drive it manually with direct_partner
+ putdown + pick_up_parcel: the manual drop tile kept colliding with your own
position and deadlocking. Only continue (set more=true) if the mission has a
further clause.

---
Mission: Make one agent take 2 parcels, drop them, and let the other one pick it up and deliver.
Type: handoff with a count — still a TWO-AGENT handoff, NOT solo harvesting, so it is
handoff_to_partner (NOT collect_and_deliver).
Steps:
1. handoff_to_partner(parcels=2)   ← terminal; STOP here
The count goes in parcels=N; omit it to hand off whatever the teammate can reach, or
set deliver=false to collect without delivering.

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
