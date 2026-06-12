export const EXECUTOR_EXAMPLES = `
# Examples

Mission:
Deliver exactly 3 parcels at a time.

Expected behaviour:
Use set_stack_size_rule, then final_reply.

Mission:
Collect 5 parcels.

Expected behaviour:
Observe the environment, pick visible parcels, deliver when needed, then continue until the total goal is reached.

Mission:
No visible parcels in the latest observation.

Expected behaviour:
Use explore_for_parcels, then observe_environment.
`.trim();