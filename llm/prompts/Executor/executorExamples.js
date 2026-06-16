export const EXECUTOR_EXAMPLES = `
# Examples

Mission:
Deliver stacks of exactly 3 parcels at a time.

Expected behaviour:
Call set_stack_size_rule with mode="exactly" and count=3.
Then call final_reply.
Do not start collecting or delivering unless the mission explicitly asks to do it now.

Mission:
Every time you deliver 5 parcels you get a 500 pt bonus.

Expected behaviour:
This is a standing scoring rule, not a task.
Call set_stack_size_rule with mode="exactly", count=5, metReward=500.
Then call final_reply.
Do NOT collect, pick up, or deliver any parcels to earn the bonus.

Mission:
Deliver at least 4 parcels to get a +50 bonus.

Expected behaviour:
Call set_stack_size_rule with mode="at_least", count=4, metReward=50.
Then call final_reply.
Do NOT start collecting parcels.

Mission:
From now on, ignore parcels with reward higher than 10.

Expected behaviour:
Call set_parcel_reward_filter with maxReward=10.
Then call final_reply.

Mission:
Deliver the parcels you are carrying.

Active rules:
- Deliver exactly 3 parcels at a time.

Observation:
carried.count = 1
visibleParcels contains valid parcels.

Expected behaviour:
Do not deliver yet.
Pick up visible parcels until the carried count satisfies the active stack-size rule.
Then deliver_carried_parcels.

Mission:
Collect 5 parcels.

Expected behaviour:
Observe the environment.
Pick up visible parcels that help the goal.
Deliver when needed.
Continue collecting until 5 parcels have been collected in total.
Do not stop after only one partial delivery.

Mission:
Collect 5 parcels.

Observation:
visibleParcels is empty.

Expected behaviour:
Call explore_for_parcels.
Then call observe_environment.
Continue the mission from the new observation.

Mission:
Deliver at the nearest delivery tile.

Expected behaviour:
Call resolve_delivery_tile with query="nearest".
Then deliver_carried_parcels at the resolved coordinates.

Mission:
Deliver the carried parcels.

Observation:
deliver_carried_parcels is rejected because the active stack-size rule requires exactly 3 parcels.

Expected behaviour:
Treat the rejection as the latest observation.
Do not repeat the same delivery action.
Collect more valid parcels if possible, then deliver when the rule is satisfied.

Mission:
Every time you deliver in (2,4), you get 5x reward.

Expected behaviour:
Call set_delivery_tile_multiplier with x=2, y=4, multiplier=5.
Then call final_reply.

Mission:
Do not go through tile (6,8).

Expected behaviour:
Call block_navigation_tile with x=6, y=8.
Then call final_reply.

Mission:
Both of you move to within 3 tiles of (10,4) and wait for each other.

Expected behaviour:
Call rendezvous_with_partner with x=10, y=4, maxDist=3.
When it returns, both agents have arrived — the rendezvous is complete.
Call final_reply.

Why rendezvous_with_partner and not direct_partner + move_near + wait_for_partner?
Those three calls in sequence leave a gap where the LLM might wrongly add
direct_partner("wait", signal="X") — which parks the partner forever on a signal
that never comes. rendezvous_with_partner closes the barrier atomically with no gap.

Mission:
One of you picks up parcel p1 at (2,2); the other delivers it.

Expected behaviour:
Call direct_partner with command="pickup", x=2, y=2, parcelId="p1" (note the cid).
Call wait_for_partner with that cid.
Call direct_partner with command="putdown", x=<handoff>, y=<handoff> (note the cid).
Call wait_for_partner with that cid.
Call pick_up_parcel at the handoff tile, then deliver_carried_parcels at a delivery tile.
Call direct_partner with command="resume".
Then call final_reply.

Mission:
Let's play red light green light: go to an odd row and wait for my go.

Expected behaviour:
Call direct_partner with command="go_to" to an odd-row tile for the teammate (note the cid).
Call wait_for_partner with that cid.
Call move_to an odd-row tile for yourself.
Call direct_partner with command="wait", signal="go-1".
Call final_reply stating you are ready and waiting for the green light.
(Do NOT call resume here — the partner is intentionally parked on signal "go-1".)

Mission:
green

Active coordination shows partnerParkedOn = "go-1".

Expected behaviour:
Call signal_partner with signal="go-1" (releases the teammate's wait).
Call direct_partner with command="resume".
Then call final_reply.
`.trim();