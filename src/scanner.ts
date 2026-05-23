import {
  Block,
  FundsLockFailedEvent,
  FundsLockedEvent,
  IBlockchainNode,
  INotifier,
  RawLog,
  SwapCancelledEvent,
  SwapNotification,
  SwapOutcome,
  SwapRequestedEvent,
  SwapSettledEvent,
} from './types';
import { IStateStore, InMemoryStateStore, PendingSwap } from './state-store';
import { DEFAULT_RETRY, RetryConfig, withRetry } from './retry';

const VAULT_SWAP_CONTRACT = '0xVaultSwap';

// Notifier failures are usually network/peer flakes — try harder than for
// node RPC, but ultimately tolerate failure: undelivered notifications stay
// in the outbox for a separate drainer worker to retry.
const DEFAULT_NOTIFY_RETRY: RetryConfig = {
  maxAttempts: 6,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
};

type ParsedSwapEvent =
  | SwapRequestedEvent
  | FundsLockedEvent
  | SwapSettledEvent
  | FundsLockFailedEvent
  | SwapCancelledEvent;

type TerminalEvent = SwapSettledEvent | FundsLockFailedEvent | SwapCancelledEvent;

function parseLog(log: RawLog, blockNumber: number): ParsedSwapEvent | null {
  if (log.address !== VAULT_SWAP_CONTRACT) return null;

  const txHash = String(log.args['txHash'] ?? '');

  switch (log.event) {
    case 'SwapRequested':
      return {
        type: 'SwapRequested',
        swapId: String(log.args['swapId']),
        user: String(log.args['user']),
        tokenIn: String(log.args['tokenIn']),
        tokenOut: String(log.args['tokenOut']),
        amountIn: String(log.args['amountIn']),
        blockNumber,
        txHash,
      };
    case 'FundsLocked':
      return {
        type: 'FundsLocked',
        swapId: String(log.args['swapId']),
        vault: String(log.args['vault']),
        amountIn: String(log.args['amountIn']),
        blockNumber,
        txHash,
      };
    case 'SwapSettled':
      return {
        type: 'SwapSettled',
        swapId: String(log.args['swapId']),
        amountOut: String(log.args['amountOut']),
        status: log.args['status'] === 'expired' ? 'expired' : 'filled',
        blockNumber,
        txHash,
      };
    case 'FundsLockFailed':
      return {
        type: 'FundsLockFailed',
        swapId: String(log.args['swapId']),
        vault: String(log.args['vault']),
        reason: String(log.args['reason'] ?? ''),
        blockNumber,
        txHash,
      };
    case 'SwapCancelled':
      return {
        type: 'SwapCancelled',
        swapId: String(log.args['swapId']),
        by: String(log.args['by'] ?? ''),
        reason: String(log.args['reason'] ?? ''),
        blockNumber,
        txHash,
      };
    default:
      return null;
  }
}

export interface VaultSwapScannerOptions {
  /**
   * Last-processed block to seed the cursor on first run. Scanning begins
   * at `startBlock + 1`. Ignored if state already has a saved cursor.
   */
  startBlock?: number;
  /** Stay this many blocks behind head. Cheap reorg defense; 0 is fine for tests. */
  confirmations?: number;
  /** Injectable state store. Production = DB; default = in-memory. */
  state?: IStateStore;
  /** Retry shape for transient node errors. */
  retry?: RetryConfig;
  /** Retry shape for notifier dispatch. */
  notifyRetry?: RetryConfig;
}

/**
 * Scanner: walks the chain, correlates VaultSwap events by swapId,
 * emits one notification per swap on terminal state.
 *
 * Terminal states (see PROTOCOL.md for the full matrix):
 *   - SwapSettled       -> outcome 'filled' or 'expired'
 *   - FundsLockFailed   -> outcome 'lock_failed'
 *   - SwapCancelled     -> outcome 'cancelled'
 *
 * Delivery model — transactional outbox:
 *   1. On any terminal event, the scanner atomically marks the swap emitted,
 *      enqueues its notification in the outbox, and clears pending state
 *      After it, the scanner has durably accepted responsibility for delivering the notification.
 *   2. Inline delivery is attempted for current swap.
 *      Success -> markDelivered (remove from outbox).
 *      Failure -> log, leave in outbox, move on.
 *   3. Stuck outbox entries: In production a separate background
 *      job (worker) drains the outbox by
 *      staleness with its own retry/backoff and concurrency control.
 *
 * Restart safety: hasEmitted(swapId) is the source of truth for "already-terminal."
 * A restart that re-reads any terminal event sees hasEmitted=true and drops it.
 * No double-emit at this layer. Downstream consumers close it by being idempotent on swapId.
 */
export class VaultSwapScanner {
  private readonly node: IBlockchainNode;
  private readonly notifier: INotifier;
  private readonly state: IStateStore;
  private readonly confirmations: number;
  private readonly retry: RetryConfig;
  private readonly notifyRetry: RetryConfig;
  private readonly initialStartBlock: number;

  constructor(
    node: IBlockchainNode,
    notifier: INotifier,
    optionsOrStartBlock: VaultSwapScannerOptions | number = {},
  ) {
    this.node = node;
    this.notifier = notifier;

    // Backwards-compat: src/index.ts passes a positional startBlock.
    const opts: VaultSwapScannerOptions =
      typeof optionsOrStartBlock === 'number' ? { startBlock: optionsOrStartBlock } : optionsOrStartBlock;

    this.initialStartBlock = opts.startBlock ?? 0;
    this.confirmations = opts.confirmations ?? 0;
    this.state = opts.state ?? new InMemoryStateStore();
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.notifyRetry = opts.notifyRetry ?? DEFAULT_NOTIFY_RETRY;
  }

  /**
   * Walk from the persisted cursor (or `startBlock` on first run) up to
   * `head - confirmations`, processing every block exactly once.
   *
   * Failure policy: every external call lives in its own try/catch. On
   * exhausted retries we log with structured context and return
   * gracefully without advancing the cursor. The next start() call
   * resumes exactly where we left off. We never advance past a block we
   * could not read — that would silently drop events.
   *
   * Production wraps this in an outer polling loop with a fixed interval.
   */
  async start(): Promise<void> {
    let head: number;
    try {
      head = await withRetry(() => this.node.getLatestBlockNumber(), this.retry);
    } catch (err) {
      console.error('[scanner] failed to fetch head block after retries; aborting this run', err);
      return;
    }

    const safeHead = head - this.confirmations;
    const savedCursor = await this.state.getCursor();
    const from = (savedCursor ?? this.initialStartBlock) + 1;

    if (from > safeHead) {
      // Caught up, or head is inside the confirmations window.
      return;
    }

    for (let n = from; n <= safeHead; n++) {
      let block: Block;
      try {
        block = await withRetry(() => this.node.getBlock(n), this.retry);
      } catch (err) {
        console.error(
          `[scanner] failed to fetch block ${n} after retries; halting run, cursor stays at ${
            savedCursor ?? this.initialStartBlock
          }`,
          err,
        );
        return;
      }

      try {
        for (const log of block.logs) {
          const ev = parseLog(log, n);
          if (ev) await this.handleEvent(ev);
        }
      } catch (err) {
        // State-store failure mid-finalize (or any unexpected throw inside event handling) lands here.
				// We do NOT advance the cursor — next run re-processes this block.
				// hasEmitted makes already-emitted swaps no-ops, so re-processing is safe.
        console.error(`[scanner] error processing block ${n}; halting run, will retry next invocation`, err);
        return;
      }

      try {
        await this.state.setCursor(n);
      } catch (err) {
        console.error(
          `[scanner] failed to persist cursor after block ${n}; halting run, next invocation will re-process this block`,
          err,
        );
        return;
      }
    }
  }

  private async handleEvent(ev: ParsedSwapEvent): Promise<void> {
    // Already-emitted swaps are terminal.
		// Any further events for them are late duplicates (reorg-replayed log, or a buggy chain) — drop.
    if (await this.state.hasEmitted(ev.swapId)) return;

    switch (ev.type) {
      case 'SwapRequested':
        await this.state.setRequested(ev.swapId, ev);
        return;
      case 'FundsLocked':
        await this.state.setFundsLocked(ev.swapId, ev);
        return;
      case 'SwapSettled':
      case 'FundsLockFailed':
      case 'SwapCancelled':
        await this.finalize(ev);
        return;
    }
  }

  /**
   * Terminal-state handler.
   *
   *   1. Build notification from accumulated pending state + this terminal event.
   *   2. recordTerminal - atomic commit (markEmitted + enqueue outbox + clearPending).
   *   3. Inline notify for current swap, with retry.
   *   4. On success -> markDelivered (remove from outbox).
   *      On failure -> log; entry stays in outbox; background drainer job (worker) picks it up later.
   *
   * If recordTerminal itself throws, we let it propagate — start()'s
   * catch halts the run, the cursor doesn't advance, the block is
   * re-processed on next invocation, and hasEmitted keeps us idempotent.
   */
  private async finalize(ev: TerminalEvent): Promise<void> {
    const pending: PendingSwap = (await this.state.getPending(ev.swapId)) ?? {};

    // Every notification requires the originating SwapRequested.
    // Without it we'd be fabricating a swap from partial data — the most
    // common cause is a scanner that started mid-stream.
    if (!pending.requested) {
      console.warn(
        `[scanner] orphan ${ev.type} ignored swapId=${ev.swapId} blockNumber=${ev.blockNumber}: no SwapRequested in our view`,
      );
      return;
    }

    let outcome: SwapOutcome;
    let extra: Partial<SwapNotification>;

    switch (ev.type) {
      case 'SwapSettled':
        // Settled implies a successful lock per protocol; refuse to emit
        // a settle that contradicts our pending state.
        if (!pending.fundsLocked) {
          console.warn(
            `[scanner] orphan SwapSettled ignored swapId=${ev.swapId} blockNumber=${ev.blockNumber}: no FundsLocked in our view`,
          );
          return;
        }
        outcome = ev.status;
        extra = { settled: ev };
        break;
      case 'FundsLockFailed':
        outcome = 'lock_failed';
        extra = { lockFailed: ev };
        break;
      case 'SwapCancelled':
        outcome = 'cancelled';
        extra = { cancelled: ev };
        break;
    }

    const notification: SwapNotification = {
      swapId: ev.swapId,
      outcome,
      requested: pending.requested,
      fundsLocked: pending.fundsLocked,
      ...extra,
    };

    // Commit point
    await this.state.recordTerminal(ev.swapId, notification);

    // Inline delivery for current swap only — bounded work, predictable tick latency.
		// Stuck outbox entries are handled by a separate job (worker).
    try {
      await withRetry(() => this.notifier.notify(notification), this.notifyRetry);
    } catch (err) {
      console.error(
        `[scanner] inline delivery failed swapId=${ev.swapId} after retries; remains in outbox for background drainer`,
        err,
      );
      return;
    }

    try {
      await this.state.markDelivered(ev.swapId);
    } catch (err) {
      // Wire delivery succeeded but we couldn't record it.
			// Background drainer job (worker) will re-deliver from the outbox - possible duplicate at the consumer.
			// The "consumer idempotent on swapId" contract closes this gap.
      console.error(
        `[scanner] markDelivered failed AFTER successful notify swapId=${ev.swapId} — possible duplicate when drainer next runs`,
        err,
      );
    }
  }
}
