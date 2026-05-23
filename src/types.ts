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

// ── Loan protocol events (Part 4) ─────────────────────────────────────────────

export interface LoanRequestedEvent {
  type: 'LoanRequested';
  loanId: string;
  borrower: string;
  amount: string;
  dueBlock: number;
  blockNumber: number;
  txHash: string;
}

export interface LoanRepaidEvent {
  type: 'LoanRepaid';
  loanId: string;
  borrower: string;
  amountRepaid: string;
  blockNumber: number;
  txHash: string;
}

export type LoanOutcome = 'repaid' | 'defaulted';

// `repaid` notifications carry the LoanRepaid event; `defaulted`
// notifications are scanner-emitted at `dueBlock` so the repaid slot is
// absent. This is *safe* time-based detection: `dueBlock` is part of the
// LoanRequested payload itself — the chain defines the timeout, not us.
export interface LoanNotification {
  loanId: string;
  outcome: LoanOutcome;
  requested: LoanRequestedEvent;
  repaid?: LoanRepaidEvent;
}

// ── Notifier interface ────────────────────────────────────────────────────────

// Generic so the same shape is reused for swaps, loans, and any future
// operation. The default keeps Part-1..3 call sites (`INotifier` without a
// type arg) compiling unchanged.
export interface INotifier<T = SwapNotification> {
  notify(notification: T): Promise<void>;
}
