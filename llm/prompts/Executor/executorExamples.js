export const EXECUTOR_EXAMPLES = `
# Examples

Mission:
Deliver stacks of exactly 3 parcels at a time.

Expected behaviour:
Call set_stack_size_rule with mode="exactly" and count=3.
Then call final_reply.
Do not start collecting or delivering unless the mission explicitly asks to do it now.

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
`.trim();