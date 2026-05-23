# VaultSwap Protocol - Part 3 Notes

The original protocol only models the happy path. A swap either settles
or goes silent. Downstream systems doing refunds or accounting can't
tell "still pending" from "vault rejected" or "user cancelled" - they
have to guess from timeouts, which is unsafe when real money is involved.

So I added two events for the failure paths the protocol left implicit:

```ts
FundsLockFailed(swapId, vault, reason)
SwapCancelled(swapId, by, reason)
```

And widened the notification shape:

```ts
type SwapOutcome = 'filled' | 'expired' | 'lock_failed' | 'cancelled';

interface SwapNotification {
  swapId: string;
  outcome: SwapOutcome;
  requested: SwapRequestedEvent;
  fundsLocked?: FundsLockedEvent;
  lockFailed?: FundsLockFailedEvent;
  cancelled?: SwapCancelledEvent;
  settled?: SwapSettledEvent;
}
```

`outcome` tells the consumer which terminal state was reached and which
event slot to read. I considered a flat discriminated union (one variant
per outcome) but went with the optional-slot shape because consumers
almost always want `requested` plus whatever else - repeating the
request fields in every variant felt worse than the runtime check.

## Terminal states

| Last event | Outcome | Slots populated |
| --- | --- | --- |
| `SwapSettled(filled)` | `filled` | requested, fundsLocked, settled |
| `SwapSettled(expired)` | `expired` | requested, fundsLocked, settled |
| `FundsLockFailed` | `lock_failed` | requested, lockFailed |
| `SwapCancelled` before lock | `cancelled` | requested, cancelled |
| `SwapCancelled` after lock | `cancelled` | requested, fundsLocked, cancelled |

Invariants the scanner enforces:

- No notification without a prior `SwapRequested`. Terminals for a swap
  we never saw start are logged as orphans and dropped - usually means
  the scanner started mid-stream.
- Terminal states are sticky. After a terminal fires, any later event
  for the same swapId is dropped by the `hasEmitted` guard. Tested.
- `SwapSettled` without a prior `FundsLocked` in our view is dropped.
  That's a protocol invariant violation, not something to silently emit.

## What I didn't do

**Scanner-invented timeouts.** Tempting to add "requested N blocks ago,
never settled -> emit `timed_out`," but a scanner that fabricates
terminal states diverges from chain truth. Anything touching money
(refunds, accounting, risk) should never react to a notification the
chain didn't actually emit. If the product needs a stuck-swap signal,
the right shape is a new on-chain event (`SwapTimedOut`) or an
operational alert outside the notification path. Loans (Part 4) are
different because `dueBlock` is part of the request event itself, so
the chain defines the timeout, not the scanner.

**Full parentHash rollback for deep reorgs.** The `confirmations` lag
knob covers shallow reorgs. True parentHash-chain rollback (track
recent block hashes, detect mismatches, reverse pending and emitted
state) is the next step and would have multiplied the test surface
beyond the 4-hour budget.

**Distributed locking for multi-instance.** Two scanners against the
same state store will race on `recordTerminal` and double-emit.
Production fixes: leader election, partitioning by swapId hash, or a
unique constraint in the database so the second writer fails loudly.
Single-instance is assumed here.

**Backfill before startBlock.** If a swap began before the scanner
started, we never see its `SwapRequested` and any later event becomes
an orphan. Proper fix is a separate backfill path that walks history
before the live tail picks up. The state store interface and
`hasEmitted` guard wouldn't need to change to support it.

## Test coverage for Part 3

Added scenarios:

1. `FundsLockFailed` after `SwapRequested` → `lock_failed` notification,
   no `fundsLocked` slot, no `settled` slot.
2. `SwapCancelled` before `FundsLocked` -> `cancelled` notification with
   no `fundsLocked` slot.
3. `SwapCancelled` after `FundsLocked` -> `cancelled` notification that
   carries the prior `fundsLocked`.
4. Mutual exclusivity: a `SwapSettled` arriving after a `SwapCancelled`
   has already terminated the swap is dropped.