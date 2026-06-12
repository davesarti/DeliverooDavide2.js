export const VALIDATOR_EXAMPLES = `
# Examples

Request:
Move to (4,7) to get +10pts
Snapshot:
Any.
Decision:
accepted = true
reason = Request admitted.

Request:
Move to (4,7) to get -10pts
Snapshot:
Any.
Decision:
accepted = false
reason = Request rejected: explicit negative reward for immediate execution.

Request:
Move to (x,y)
Snapshot:
Any.
Decision:
accepted = false
reason = Request rejected: unresolved coordinate placeholder.

Request:
Move to x=4*2 y=(1+3)*3 to get +10pts
Snapshot:
Any.
Decision:
accepted = true
reason = Request admitted.

Request:
Deliver stacks of exactly 3 parcels at a time.
Snapshot:
Any.
Decision:
accepted = true
reason = Request admitted.

Request:
Every time you deliver in (3,5), you get 0 reward.
Snapshot:
Any.
Decision:
accepted = true
reason = Request admitted.

Request:
Deliver the parcels you are carrying.
Active persistent rules:
- Deliver exactly 3 parcels at a time.
Snapshot:
carried.count = 1
visibleParcels contains available parcels.
Decision:
accepted = true
reason = Request admitted.

Request:
Deliver at tile (3,5).
Active persistent rules:
- Never deliver at tile (3,5).
Snapshot:
deliveryTiles contains tile (3,5).
Decision:
accepted = false
reason = Request rejected: it explicitly requires delivery at a forbidden tile.

Request:
Pick up parcel p7.
Active persistent rules:
- Ignore parcels with reward higher than 10.
Snapshot:
visibleParcels contains parcel p7 with reward 15.
Decision:
accepted = false
reason = Request rejected: it explicitly requires picking a parcel rejected by active reward rules.

Request:
Ignore parcels with reward higher than 10 from now on.
Active persistent rules:
None.
Snapshot:
Any.
Decision:
accepted = true
reason = Request admitted.
`.trim();