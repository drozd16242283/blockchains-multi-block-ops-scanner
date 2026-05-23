import { VaultSwapScanner } from '../src/scanner';
import { SimulatedNode } from '../src/node';
import { InMemoryStateStore } from '../src/state-store';
import { Block, IBlockchainNode, INotifier, RawLog, SwapNotification } from '../src/types';

class CapturingNotifier implements INotifier {
  public notifications: SwapNotification[] = [];
  async notify(n: SwapNotification): Promise<void> {
    this.notifications.push(n);
  }
}

class FlakyNotifier implements INotifier {
  public notifications: SwapNotification[] = [];
  constructor(private failuresLeft: number) {}
  async notify(n: SwapNotification): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('notifier flake');
    }
    this.notifications.push(n);
  }
}

class AlwaysFailingNotifier implements INotifier {
  async notify(): Promise<void> {
    throw new Error('notifier permanently down');
  }
}

/** Wraps a node and throws the first N getBlock(n) calls per block number. */
class FlakyNode implements IBlockchainNode {
  private failures = new Map<number, number>();
  constructor(private inner: IBlockchainNode, failuresPerBlock: Record<number, number> = {}) {
    for (const [k, v] of Object.entries(failuresPerBlock)) this.failures.set(Number(k), v);
  }
  async getLatestBlockNumber() {
    return this.inner.getLatestBlockNumber();
  }
  async getBlock(n: number) {
    const remaining = this.failures.get(n) ?? 0;
    if (remaining > 0) {
      this.failures.set(n, remaining - 1);
      throw new Error(`flake on block ${n}`);
    }
    return this.inner.getBlock(n);
  }
}

const VAULT = '0xVaultSwap';

const block = (number: number, logs: RawLog[]): Block => ({
  number,
  hash: `0xh${number}`,
  parentHash: `0xh${number - 1}`,
  logs,
});

const requested = (swapId: string): RawLog => ({
  address: VAULT,
  event: 'SwapRequested',
  args: { txHash: `0xtx_${swapId}_req`, swapId, user: '0xAlice', tokenIn: 'LTC', tokenOut: 'BTC', amountIn: '10000000' },
});

const locked = (swapId: string): RawLog => ({
  address: VAULT,
  event: 'FundsLocked',
  args: { txHash: `0xtx_${swapId}_lock`, swapId, vault: '0xVault1', amountIn: '10000000' },
});

const settledLog = (swapId: string, status: 'filled' | 'expired' = 'filled'): RawLog => ({
  address: VAULT,
  event: 'SwapSettled',
  args: { txHash: `0xtx_${swapId}_set`, swapId, amountOut: '9950000', status },
});

const lockFailed = (swapId: string, reason = 'insufficient_liquidity'): RawLog => ({
  address: VAULT,
  event: 'FundsLockFailed',
  args: { txHash: `0xtx_${swapId}_lockfail`, swapId, vault: '0xVault1', reason },
});

const cancelled = (swapId: string, by = '0xAlice', reason = 'user_abort'): RawLog => ({
  address: VAULT,
  event: 'SwapCancelled',
  args: { txHash: `0xtx_${swapId}_cancel`, swapId, by, reason },
});

const fastRetry = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 };
const fastNotifyRetry = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 };

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});


test('happy path: three events across three blocks → one filled notification, state cleaned up', async () => {
  const notifier = new CapturingNotifier();
  const state = new InMemoryStateStore();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ]);

  await new VaultSwapScanner(node, notifier, { state }).start();

  expect(notifier.notifications).toHaveLength(1);
  const n = notifier.notifications[0];
  expect(n.swapId).toBe('s1');
  expect(n.outcome).toBe('filled');
  expect(n.requested.blockNumber).toBe(1);
  expect(n.fundsLocked?.blockNumber).toBe(2);
  expect(n.settled?.blockNumber).toBe(3);
  expect(await state.getPendingDeliveries()).toHaveLength(0);
  expect(await state.getPending('s1')).toBeUndefined();
  expect(await state.getCursor()).toBe(3);
});

test('expired outcome propagates through to the notification', async () => {
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'expired')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(1);
  expect(notifier.notifications[0].outcome).toBe('expired');
});

test('atomic swap: all three events in a single block -> one notification', async () => {
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [requested('s1'), locked('s1'), settledLog('s1', 'filled')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(1);
});

test('two interleaved swaps stay independent (correlation by swapId)', async () => {
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [requested('A'), requested('B')]),
    block(2, [locked('B'), locked('A')]),
    block(3, [settledLog('A', 'filled')]),
    block(4, [settledLog('B', 'expired')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(2);
  const byId = Object.fromEntries(notifier.notifications.map((n) => [n.swapId, n]));
  expect(byId['A'].outcome).toBe('filled');
  expect(byId['B'].outcome).toBe('expired');
});

test('restart idempotency: calling start() twice never re-emits', async () => {
  const notifier = new CapturingNotifier();
  const state = new InMemoryStateStore();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ]);

  const scanner = new VaultSwapScanner(node, notifier, { state });
  await scanner.start();
  await scanner.start();

  expect(notifier.notifications).toHaveLength(1);
});

test('pending state survives a restart mid-flight', async () => {
  const notifier = new CapturingNotifier();
  const state = new InMemoryStateStore();

  await new VaultSwapScanner(
    new SimulatedNode([block(1, [requested('s1')]), block(2, [locked('s1')])]),
    notifier,
    { state },
  ).start();
  expect(notifier.notifications).toHaveLength(0);

  await new VaultSwapScanner(
    new SimulatedNode([
      block(1, [requested('s1')]),
      block(2, [locked('s1')]),
      block(3, [settledLog('s1', 'filled')]),
    ]),
    notifier,
    { state },
  ).start();

  expect(notifier.notifications).toHaveLength(1);
});

test('transient node failure: retried within budget, scan completes normally', async () => {
  const notifier = new CapturingNotifier();
  const inner = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ]);
  const flaky = new FlakyNode(inner, { 2: 2 });

  await new VaultSwapScanner(flaky, notifier, { retry: fastRetry }).start();

  expect(notifier.notifications).toHaveLength(1);
});

test('permanent node failure: start() halts gracefully, cursor stays at last good block', async () => {
  const notifier = new CapturingNotifier();
  const state = new InMemoryStateStore();
  const flaky = new FlakyNode(
    new SimulatedNode([
      block(1, [requested('s1')]),
      block(2, [locked('s1')]),
      block(3, [settledLog('s1', 'filled')]),
    ]),
    { 2: 999 },
  );

  await expect(
    new VaultSwapScanner(flaky, notifier, { state, retry: { maxAttempts: 2, baseDelayMs: 1 } }).start(),
  ).resolves.toBeUndefined();

  expect(notifier.notifications).toHaveLength(0);
  expect(await state.getCursor()).toBe(1);
});

test('mid-stream start: orphan SwapSettled is logged and dropped', async () => {
  const notifier = new CapturingNotifier();
  const warnSpy = jest.spyOn(console, 'warn');
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ]);

  await new VaultSwapScanner(node, notifier, { startBlock: 2 }).start();

  expect(notifier.notifications).toHaveLength(0);
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('orphan SwapSettled'));
});

test('confirmations lag: settle inside the window is held back until head advances', async () => {
  const notifier = new CapturingNotifier();
  const state = new InMemoryStateStore();

  let blocks: Block[] = [
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ];
  await new VaultSwapScanner(new SimulatedNode(blocks), notifier, { state, confirmations: 2 }).start();
  expect(notifier.notifications).toHaveLength(0);

  blocks = [...blocks, block(4, []), block(5, [])];
  await new VaultSwapScanner(new SimulatedNode(blocks), notifier, { state, confirmations: 2 }).start();
  expect(notifier.notifications).toHaveLength(1);
});

test('unrelated logs (wrong address, unknown event) are ignored', async () => {
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [
      requested('s1'),
      {
        address: '0xOtherContract',
        event: 'SwapRequested',
        args: { swapId: 'noise', user: '0x', tokenIn: '', tokenOut: '', amountIn: '0' },
      },
      { address: VAULT, event: 'UnrelatedEvent', args: { swapId: 's1' } },
    ]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(1);
  expect(notifier.notifications[0].swapId).toBe('s1');
});

test('transient notifier failure: retried within budget, single notification delivered, outbox empty', async () => {
  const notifier = new FlakyNotifier(2);
  const state = new InMemoryStateStore();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ]);

  await new VaultSwapScanner(node, notifier, { state, notifyRetry: fastNotifyRetry }).start();

  expect(notifier.notifications).toHaveLength(1);
  expect(await state.getPendingDeliveries()).toHaveLength(0);
});

test('permanent notifier failure: swap is terminal in state, outbox holds the notification, restart does not re-emit', async () => {
  const notifier = new AlwaysFailingNotifier();
  const state = new InMemoryStateStore();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [settledLog('s1', 'filled')]),
  ]);

  await new VaultSwapScanner(node, notifier, {
    state,
    notifyRetry: { maxAttempts: 2, baseDelayMs: 1 },
  }).start();

  expect(await state.hasEmitted('s1')).toBe(true);
  expect(await state.getPendingDeliveries()).toHaveLength(1);

  await new VaultSwapScanner(node, notifier, {
    state,
    notifyRetry: { maxAttempts: 2, baseDelayMs: 1 },
  }).start();
  // Still one in the outbox; scanner did not re-attempt — that's the
  // separate drainer worker's job in production.
  expect(await state.getPendingDeliveries()).toHaveLength(1);

  // Simulate the drainer: deliver from outbox once the notifier recovers.
  const recovered = new CapturingNotifier();
  for (const n of await state.getPendingDeliveries()) {
    await recovered.notify(n);
    await state.markDelivered(n.swapId);
  }
  expect(recovered.notifications).toHaveLength(1);
  expect(await state.getPendingDeliveries()).toHaveLength(0);
});

// ── Part 3: hardened protocol ────────────────────────────────────────────

test('FundsLockFailed after Requested -> lock_failed notification, no settle expected', async () => {
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [lockFailed('s1', 'insufficient_liquidity')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(1);
  const n = notifier.notifications[0];
  expect(n.outcome).toBe('lock_failed');
  expect(n.lockFailed?.reason).toBe('insufficient_liquidity');
  expect(n.fundsLocked).toBeUndefined();
  expect(n.settled).toBeUndefined();
});

test('SwapCancelled before Locked -> cancelled notification with no fundsLocked', async () => {
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [cancelled('s1', '0xAlice', 'user_abort')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(1);
  const n = notifier.notifications[0];
  expect(n.outcome).toBe('cancelled');
  expect(n.cancelled?.by).toBe('0xAlice');
  expect(n.fundsLocked).toBeUndefined();
});

test('SwapCancelled after Locked -> cancelled notification carries the prior fundsLocked', async () => {
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [cancelled('s1', '0xProtocol', 'price_drift')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(1);
  const n = notifier.notifications[0];
  expect(n.outcome).toBe('cancelled');
  expect(n.fundsLocked).toBeDefined();
  expect(n.cancelled?.by).toBe('0xProtocol');
});

test('orphan FundsLockFailed (no prior Requested) is dropped with a warning', async () => {
  const notifier = new CapturingNotifier();
  const warnSpy = jest.spyOn(console, 'warn');
  const node = new SimulatedNode([block(1, [lockFailed('s1')])]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(0);
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('orphan FundsLockFailed'));
});

test('orphan SwapCancelled (no prior Requested) is dropped with a warning', async () => {
  const notifier = new CapturingNotifier();
  const warnSpy = jest.spyOn(console, 'warn');
  const node = new SimulatedNode([block(1, [cancelled('s1')])]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(0);
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('orphan SwapCancelled'));
});

test('terminal events are mutually exclusive: SwapSettled after SwapCancelled is dropped', async () => {
  // SwapCancelled is terminal; any later event for the same swap (including
  // a stray SwapSettled from a misbehaving chain) must be ignored.
  const notifier = new CapturingNotifier();
  const node = new SimulatedNode([
    block(1, [requested('s1')]),
    block(2, [locked('s1')]),
    block(3, [cancelled('s1')]),
    block(4, [settledLog('s1', 'filled')]),
  ]);

  await new VaultSwapScanner(node, notifier).start();

  expect(notifier.notifications).toHaveLength(1);
  expect(notifier.notifications[0].outcome).toBe('cancelled');
});
