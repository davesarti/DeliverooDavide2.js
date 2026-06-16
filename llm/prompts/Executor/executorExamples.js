export const EXECUTOR_EXAMPLES = `
# Examples

Each example shows a mission (and any context) followed by the exact tool sequence
to produce. Follow these patterns.

---
Mission: Deliver stacks of exactly 3 parcels at a time.
Type: durable rule.
Steps:
1. set_stack_size_rule(mode="exactly", count=3)
2. final_reply
Do NOT collect or deliver — storing the rule is the whole task.

---
Mission: Every time you deliver 5 parcels you get a 500 pt bonus.
Type: durable rule with a met reward.
Steps:
1. set_stack_size_rule(mode="exactly", count=5, metReward=500)
2. final_reply
Do NOT collect, pick up, or deliver anything to "earn" the bonus.

---
Mission: Deliver at least 4 parcels to get a +50 bonus.
Type: durable rule with a met reward.
Steps:
1. set_stack_size_rule(mode="at_least", count=4, metReward=50)
2. final_reply
Do NOT start collecting parcels.

---
Mission: From now on, ignore parcels with reward higher than 10.
Type: durable rule.
Steps:
1. set_parcel_reward_filter(maxReward=10)
2. final_reply

---
Mission: Every time you deliver in (2,4), you get 5x reward.
Type: durable rule.
Steps:
1. set_delivery_tile_multiplier(x=2, y=4, multiplier=5)
2. final_reply

---
Mission: Do not go through tile (6,8).
Type: durable rule.
Steps:
1. block_navigation_tile(x=6, y=8)
2. final_reply

---
Mission: Deliver the parcels you are carrying.
Active rules: Deliver exactly 3 parcels at a time.
Observation: carried.count = 1; visibleParcels contains valid parcels.
Type: action task, adapt to the active rule.
Steps:
1. Do NOT deliver yet (only 1 carried, rule wants 3).
2. pick_up_parcel for visible parcels until carried.count satisfies the stack-size rule.
3. deliver_carried_parcels.

---
Mission: Collect 5 parcels.
Type: action task.
Steps:
1. observe_environment.
2. pick_up_parcel for parcels that help the goal.
3. deliver_carried_parcels when needed.
4. Continue until 5 parcels are collected in total — do not stop after one partial delivery.

---
Mission: Collect 5 parcels.
Observation: visibleParcels is empty.
Steps:
1. explore_for_parcels.
2. observe_environment.
3. Continue the mission from the new observation.

---
Mission: Deliver at the nearest delivery tile.
Steps:
1. resolve_delivery_tile(query="nearest").
2. deliver_carried_parcels at the resolved coordinates.

---
Mission: Deliver the carried parcels.
Observation: deliver_carried_parcels was rejected because the active stack-size rule requires exactly 3 parcels.
Steps:
1. Treat the rejection as the latest observation; do NOT repeat the same delivery.
2. Collect more valid parcels if possible, then deliver once the rule is satisfied.

---
Mission: Both of you move to within 3 tiles of (10,4) and wait for each other.
Type: rendezvous.
Steps:
1. rendezvous_with_partner(x=10, y=4, maxDist=3).
2. final_reply (when it returns, both agents have arrived).
Why not direct_partner + move_near + wait_for_partner? Those three calls leave a gap
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
