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

# Loan operation (Part 4)

## Why no handler abstraction

A clean version would extract `IOperationHandler` (`onLog` + `onBlockProcessed`) and dispatch swaps + loans from one operation-agnostic scanner. 
With more time I would have done that - it scales to N operation types. 
For two operations on a deadline the inline path is easier to read and doesn't lose anything. 
A third operation type would be the moment to refactor.

## Time-based default detection - why it's safe here, not for swaps

Part 3 refuses to invent a `SwapTimedOut` outcome from nothing. 
Loans are different: `dueBlock` is part of the `LoanRequested` event itself, so the chain declares the timeout.
The scanner is observing chain truth, not fabricating it.
Refunds and accounting can react to `defaulted` with the same confidence as any chain-emitted terminal.

# Other design considerations

## Node unreliability

Every external call to the node (`getLatestBlockNumber`, `getBlock`) is wrapped in bounded exponential backoff (`retry.ts`, 4 attempts by default).
On exhausted retries the scanner logs with context and halts cleanly - the cursor doesn't advance, so the next `start()` resumes at the same block. 
We never silently skip a block we couldn't read -> that would mean dropping events.

Notifier dispatch uses a separate, more generous retry budget (6 attempts) because downstream peers are typically further away network-wise and worth waiting longer for. 
Whether the inline notify succeeds or not, the outbox holds the notification - the inline retry is an optimistic fast-path, not the durability guarantee.

Production additions:

- a circuit breaker around the RPC client so a hard-down node doesn't burn retry budget every poll cycle and hammer a struggling endpoint.
- metrics on retry count + halt reason so alerting fires on a flapping node before it shows up as user-facing lag.
- failover to a reserve node (or a pool, with health-based routing) for read paths.

## Block time at 400ms

The current scanner walks blocks sequentially in a single `start()` call. 
At 10-second blocks this keeps up easily - one `getBlock` per ~10 seconds of wall clock. 
At 400ms blocks (25x faster) several knobs flip:

- **Polling -> subscriptions.** Polling at 100ms is wasteful and racy. If the node supports a new-block WebSocket subscription, the block iterator becomes event-driven instead of polled.
- **Parallel block fetch.** Sequential `getBlock(n)` stops keeping up. Fetch a window of blocks in parallel with a concurrency cap, process them in order via a small reorder buffer.
- **`confirmations` measured in time, not blocks.** "5 blocks behind head" is 50s at 10s blocks but 2s at 400ms blocks. Replace with `safeAgeMs`, or align with chain-specific finality semantics (Solana `commitment: 'finalized'`, EVM `12 blocks behind`).
- **Outbox throughput.** Higher block rate means more terminal events per second. State-store writes batch, the drainer runs at higher concurrency.
- **State store.** Pending state turns over faster relative to terminal cleanup. The DB choice (and indexing on `swapId` /`dueBlock`) matters more.

Most of these are config knobs over the existing architecture - the scanner / state-store / correlator split survives. Parallel fetching is the one piece that would need a real change to the block-iteration loop.

## Observability

The scanner emits `console.warn` / `console.error` with a `[scanner]` prefix and structured context (`swapId`, `blockNumber`, error).
For this assignment that's the observability surface. 
Production replaces it with:

- structured logging (JSON) with severity, `swapId`, `blockNumber`, and correlation IDs from upstream chain context,
- metrics: `blocks_processed_total`, `notifications_emitted_total{outcome}`, `retry_count_total{call}`, `outbox_pending` gauge, `processing_lag_seconds` gauge,
- alerts: cursor stalled (no advance in N minutes), outbox depth growing (drainer falling behind), retry-rate spike (node degraded),
- traces spanning block-fetch -> event-parse -> finalize -> notify so end-to-end latency is attributable per swap.