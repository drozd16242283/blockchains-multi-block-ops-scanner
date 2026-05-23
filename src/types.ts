// ── Blockchain primitives - DO NOT TOUCH --────────────────────────────────────

export interface RawLog {
  address: string;   // contract address
  event: string;     // event name
  args: Record<string, string | number>;
}

export interface Block {
  number: number;
  hash: string;
  parentHash: string;
  logs: RawLog[];
}

// ── VaultSwap protocol events ─────────────────────────────────────────────────

export interface SwapRequestedEvent {
  type: 'SwapRequested';
  swapId: string;
  user: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  blockNumber: number;
  txHash: string;
}

export interface FundsLockedEvent {
  type: 'FundsLocked';
  swapId: string;
  vault: string;
  amountIn: string;
  blockNumber: number;
  txHash: string;
}

export interface SwapSettledEvent {
  type: 'SwapSettled';
  swapId: string;
  amountOut: string;
  status: 'filled' | 'expired';
  blockNumber: number;
  txHash: string;
}

// Added in Part 3: terminal events for failure paths the original
// protocol left unspecified. See PROTOCOL.md.
export interface FundsLockFailedEvent {
  type: 'FundsLockFailed';
  swapId: string;
  vault: string;
  reason: string;
  blockNumber: number;
  txHash: string;
}

export interface SwapCancelledEvent {
  type: 'SwapCancelled';
  swapId: string;
  by: string;     // who initiated the cancel (user / protocol / vault)
  reason: string;
  blockNumber: number;
  txHash: string;
}

export type SwapEvent =
  | SwapRequestedEvent
  | FundsLockedEvent
  | SwapSettledEvent
  | FundsLockFailedEvent
  | SwapCancelledEvent;

// ── Notification ──────────────────────────────────────────────────────────────

export type SwapOutcome = 'filled' | 'expired' | 'lock_failed' | 'cancelled';

// `requested` is always present (no notification without a request).
// All other event slots are populated only when seen on-chain; `outcome`
// is the single source of truth for which terminal state the swap reached.
export interface SwapNotification {
  swapId: string;
  outcome: SwapOutcome;
  requested: SwapRequestedEvent;
  fundsLocked?: FundsLockedEvent;
  lockFailed?: FundsLockFailedEvent;
  cancelled?: SwapCancelledEvent;
  settled?: SwapSettledEvent;
}

// ── Node interface ────────────────────────────────────────────────────────────

export interface IBlockchainNode {
  getLatestBlockNumber(): Promise<number>;
  getBlock(blockNumber: number): Promise<Block>;
}

// ── Notifier interface ────────────────────────────────────────────────────────

export interface INotifier {
  notify(notification: SwapNotification): Promise<void>;
}
