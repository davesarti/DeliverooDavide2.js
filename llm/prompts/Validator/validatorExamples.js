export const VALIDATOR_EXAMPLES = `
# Examples

Request:
Move to (4,7) to get +10pts
Decision:
accepted = true
reason = Request admitted.

Request:
Move to (4,7) to get -10pts
Decision:
accepted = false
reason = Request rejected: explicit negative reward.

Request:
Move to (x,y)
Decision:
accepted = false
reason = Request rejected: unresolved coordinate placeholder.

Request:
From now on deliver exactly 3 parcels at a time
Decision:
accepted = true
reason = Request admitted.

Request:
Every time you deliver in (3,5), you get 0 reward
Decision:
accepted = true
reason = Request admitted.
`.trim();