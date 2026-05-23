import { FundsLockedEvent, SwapNotification, SwapRequestedEvent } from './types';

/** Three independent state spaces:
 	*   - cursor              : last fully-processed block
	*   - pending             : partial multi-event swap state, keyed by swapId
	*   - emitted + outbox    : terminal swaps. emitted = "we've committed to
	*                           notifying"; outbox = "notification still
	*                           awaiting wire delivery".
	*  recordTerminal flips a swap from pending -> emitted+outbox atomically.
*/
export interface PendingSwap {
  requested?: SwapRequestedEvent;
  fundsLocked?: FundsLockedEvent;
}

export interface IStateStore {
  getCursor(): Promise<number | undefined>;
  setCursor(blockNumber: number): Promise<void>;

  setRequested(swapId: string, ev: SwapRequestedEvent): Promise<void>;
  setFundsLocked(swapId: string, ev: FundsLockedEvent): Promise<void>;
  getPending(swapId: string): Promise<PendingSwap | undefined>;

	/** Terminal-state finalization (atomic)
	 * Atomically: mark the swap emitted, enqueue its notification for
	 * delivery, and clear its pending state. In a real DB this is a single
	 * transaction. Calling notify() *before* this would risk losing the
	 * notification across a crash; calling notify() *after* without an
	 * outbox would risk a double-send on restart. This collapses both.
	 */
  recordTerminal(swapId: string, notification: SwapNotification): Promise<void>;
  hasEmitted(swapId: string): Promise<boolean>;

  getPendingDeliveries(): Promise<SwapNotification[]>;
  markDelivered(swapId: string): Promise<void>;
}

export class InMemoryStateStore implements IStateStore {
  private cursor: number | undefined;
  private pending = new Map<string, PendingSwap>();
  private emitted = new Set<string>();
  private outbox = new Map<string, SwapNotification>();

  async getCursor(): Promise<number | undefined> {
    return this.cursor;
  }

  async setCursor(blockNumber: number): Promise<void> {
    this.cursor = blockNumber;
  }

  async setRequested(swapId: string, ev: SwapRequestedEvent): Promise<void> {
    const current = this.pending.get(swapId) ?? {};
    this.pending.set(swapId, { ...current, requested: ev });
  }

  async setFundsLocked(swapId: string, ev: FundsLockedEvent): Promise<void> {
    const current = this.pending.get(swapId) ?? {};
    this.pending.set(swapId, { ...current, fundsLocked: ev });
  }

  async getPending(swapId: string): Promise<PendingSwap | undefined> {
    return this.pending.get(swapId);
  }

  async recordTerminal(swapId: string, notification: SwapNotification): Promise<void> {
		// In a real DB the three writes go into one transaction.
    this.emitted.add(swapId);
    this.outbox.set(swapId, notification);
    this.pending.delete(swapId);
  }

  async hasEmitted(swapId: string): Promise<boolean> {
    return this.emitted.has(swapId);
  }

  async getPendingDeliveries(): Promise<SwapNotification[]> {
    return Array.from(this.outbox.values());
  }

  async markDelivered(swapId: string): Promise<void> {
    this.outbox.delete(swapId);
  }
}
