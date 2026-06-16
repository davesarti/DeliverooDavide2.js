export const VALIDATOR_EXAMPLES = `
# Examples

Each example shows the request, any relevant snapshot, and the validate_mission
call you must produce. Match this reasoning exactly.

---
Request: Move to (4,7) to get +10pts
Snapshot: Any.
thought: Immediate mission, positive reward, no placeholder, no rule conflict.
accepted: true
reason: Request admitted.

---
Request: Move to (4,7) to get -10pts
Snapshot: Any.
thought: Immediate mission with an explicit negative reward for doing it now.
accepted: false
reason: Request rejected: explicit negative reward for immediate execution.

---
Request: Move to (x,y)
Snapshot: Any.
thought: Coordinate is an unresolved placeholder (x,y).
accepted: false
reason: Request rejected: unresolved coordinate placeholder.

---
Request: Move to x=4*2 y=(1+3)*3 to get +10pts
Snapshot: Any.
thought: Coordinates are arithmetic expressions, which resolve to numbers.
accepted: true
reason: Request admitted.

---
Request: Deliver stacks of exactly 3 parcels at a time.
Snapshot: Any.
thought: Durable strategy rule to store.
accepted: true
reason: Request admitted.

---
Request: Every time you deliver in (3,5), you get 0 reward.
Snapshot: Any.
thought: Durable rule. Reward 0 is not negative; the value is information to store.
accepted: true
reason: Request admitted.

---
Request: Delivering at tile (9,9) costs you 50 points from now on.
Snapshot: Any.
thought: Durable rule. A penalty stated inside a rule is information to store.
accepted: true
reason: Request admitted.

---
Request: Avoid delivering at (3,5), it carries a -20 penalty.
Snapshot: Any.
thought: Durable rule. The negative penalty is the rule's content, not a reason to reject.
accepted: true
reason: Request admitted.

---
Request: Deliver the parcels you are carrying.
Active persistent rules:
- Deliver exactly 3 parcels at a time.
Snapshot: carried.count = 1; visibleParcels contains available parcels.
thought: Satisfiable by adapting the plan (collect more first). Not a violation.
accepted: true
reason: Request admitted.

---
Request: Deliver at tile (3,5).
Active persistent rules:
- Never deliver at tile (3,5).
Snapshot: deliveryTiles contains tile (3,5).
thought: Immediate action directly violates an active persistent rule.
accepted: false
reason: Request rejected: it explicitly requires delivery at a forbidden tile.

---
Request: Pick up parcel p7.
Active persistent rules:
- Ignore parcels with reward higher than 10.
Snapshot: visibleParcels contains parcel p7 with reward 15.
thought: Picking p7 directly violates the active reward filter.
accepted: false
reason: Request rejected: it explicitly requires picking a parcel rejected by active reward rules.

---
Request: Ignore parcels with reward higher than 10 from now on.
Active persistent rules: None.
Snapshot: Any.
thought: Durable strategy rule to store.
accepted: true
reason: Request admitted.
`.trim();
