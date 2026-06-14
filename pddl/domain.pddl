(define (domain deliveroo)
  (:requirements :strips)

  (:predicates
    ; --- Topology ---
    ; tile ?t         : ?t is a valid walkable cell
    ; free ?t         : ?t has no agent AND no crate on it (parcels do NOT block)
    ; delivery ?t     : ?t is a delivery zone
    ; pushable ?t     : ?t is a type-5 tile — crates can be pushed here
    (tile ?t)
    (free ?t)
    (delivery ?t)
    (pushable ?t)

    ; --- Directional adjacency ---
    (up    ?from ?to)
    (down  ?from ?to)
    (left  ?from ?to)
    (right ?from ?to)

    ; --- Agent ---
    ; at-agent ?t     : agent is currently at tile ?t
    (at-agent ?t)

    ; --- Parcels ---
    ; parcel ?p       : type guard — ?p is a parcel
    ; at-parcel ?p ?t : parcel ?p is on the floor at tile ?t
    ; carrying ?p     : agent is currently carrying parcel ?p
    ; delivered ?p    : parcel ?p has been delivered (terminal state)
    (parcel ?p)
    (at-parcel ?p ?t)
    (carrying ?p)
    (delivered ?p)

    ; --- Crates ---
    ; crate ?c        : type guard — ?c is a crate
    ; at-crate ?c ?t  : crate ?c is at tile ?t
    (crate ?c)
    (at-crate ?c ?t)
  )

  ; ================================================================
  ; MOVEMENT
  ; Precondition: agent is at ?from, ?to is adjacent, ?to is free.
  ; Effect: agent moves to ?to; ?from becomes free, ?to becomes occupied.
  ; ================================================================

  (:action move-up
    :parameters (?from ?to)
    :precondition (and
      (at-agent ?from)
      (up ?from ?to)
      (free ?to)
    )
    :effect (and
      (at-agent ?to)
      (not (at-agent ?from))
      (free ?from)
      (not (free ?to))
    )
  )

  (:action move-down
    :parameters (?from ?to)
    :precondition (and
      (at-agent ?from)
      (down ?from ?to)
      (free ?to)
    )
    :effect (and
      (at-agent ?to)
      (not (at-agent ?from))
      (free ?from)
      (not (free ?to))
    )
  )

  (:action move-left
    :parameters (?from ?to)
    :precondition (and
      (at-agent ?from)
      (left ?from ?to)
      (free ?to)
    )
    :effect (and
      (at-agent ?to)
      (not (at-agent ?from))
      (free ?from)
      (not (free ?to))
    )
  )

  (:action move-right
    :parameters (?from ?to)
    :precondition (and
      (at-agent ?from)
      (right ?from ?to)
      (free ?to)
    )
    :effect (and
      (at-agent ?to)
      (not (at-agent ?from))
      (free ?from)
      (not (free ?to))
    )
  )

  ; ================================================================
  ; PICKUP
  ; Precondition: agent and parcel are on the same tile.
  ; Effect: parcel is now carried; it disappears from the floor.
  ; Note: free is NOT changed — parcels never affect tile occupancy.
  ; ================================================================

  (:action pickup
    :parameters (?p ?t)
    :precondition (and
      (parcel ?p)
      (at-agent ?t)
      (at-parcel ?p ?t)
    )
    :effect (and
      (carrying ?p)
      (not (at-parcel ?p ?t))
    )
  )

  ; ================================================================
  ; PUTDOWN (delivery)
  ; Precondition: agent is carrying ?p and is on a delivery tile.
  ; Effect: parcel is marked delivered; agent is no longer carrying it.
  ; Note: free is NOT changed — parcels never affect tile occupancy.
  ; ================================================================

  (:action putdown
    :parameters (?p ?t)
    :precondition (and
      (parcel ?p)
      (carrying ?p)
      (at-agent ?t)
      (delivery ?t)
    )
    :effect (and
      (delivered ?p)
      (not (carrying ?p))
    )
  )

  ; ================================================================
  ; PUSH ACTIONS
  ;
  ; Layout:  agentPos → cratePos → destPos  (all in the same direction)
  ;
  ; Preconditions:
  ;   - agent is at agentPos
  ;   - crate is at cratePos
  ;   - agentPos → cratePos is adjacent in the push direction
  ;   - cratePos → destPos is adjacent in the same direction
  ;   - destPos is free (no agent, no crate)
  ;   - destPos is pushable (type-5 tile)
  ;
  ; Effects:
  ;   - agent moves from agentPos to cratePos
  ;   - crate moves from cratePos to destPos
  ;   - agentPos becomes free
  ;   - destPos becomes occupied (not free)
  ;   - cratePos stays NOT free (agent is now there)
  ;
  ; Execution: at runtime push-* maps to actions.move(direction),
  ; identical to move-*. The server handles the push automatically.
  ; ================================================================

  (:action push-up
    :parameters (?c ?agentPos ?cratePos ?destPos)
    :precondition (and
      (crate ?c)
      (at-agent ?agentPos)
      (at-crate ?c ?cratePos)
      (up ?agentPos ?cratePos)
      (up ?cratePos ?destPos)
      (free ?destPos)
      (pushable ?destPos)
    )
    :effect (and
      (at-agent ?cratePos)
      (not (at-agent ?agentPos))
      (free ?agentPos)
      (at-crate ?c ?destPos)
      (not (at-crate ?c ?cratePos))
      (not (free ?destPos))
    )
  )

  (:action push-down
    :parameters (?c ?agentPos ?cratePos ?destPos)
    :precondition (and
      (crate ?c)
      (at-agent ?agentPos)
      (at-crate ?c ?cratePos)
      (down ?agentPos ?cratePos)
      (down ?cratePos ?destPos)
      (free ?destPos)
      (pushable ?destPos)
    )
    :effect (and
      (at-agent ?cratePos)
      (not (at-agent ?agentPos))
      (free ?agentPos)
      (at-crate ?c ?destPos)
      (not (at-crate ?c ?cratePos))
      (not (free ?destPos))
    )
  )

  (:action push-left
    :parameters (?c ?agentPos ?cratePos ?destPos)
    :precondition (and
      (crate ?c)
      (at-agent ?agentPos)
      (at-crate ?c ?cratePos)
      (left ?agentPos ?cratePos)
      (left ?cratePos ?destPos)
      (free ?destPos)
      (pushable ?destPos)
    )
    :effect (and
      (at-agent ?cratePos)
      (not (at-agent ?agentPos))
      (free ?agentPos)
      (at-crate ?c ?destPos)
      (not (at-crate ?c ?cratePos))
      (not (free ?destPos))
    )
  )

  (:action push-right
    :parameters (?c ?agentPos ?cratePos ?destPos)
    :precondition (and
      (crate ?c)
      (at-agent ?agentPos)
      (at-crate ?c ?cratePos)
      (right ?agentPos ?cratePos)
      (right ?cratePos ?destPos)
      (free ?destPos)
      (pushable ?destPos)
    )
    :effect (and
      (at-agent ?cratePos)
      (not (at-agent ?agentPos))
      (free ?agentPos)
      (at-crate ?c ?destPos)
      (not (at-crate ?c ?cratePos))
      (not (free ?destPos))
    )
  )

)
