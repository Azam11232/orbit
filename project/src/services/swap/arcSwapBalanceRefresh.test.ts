import { describe, expect, it, vi } from 'vitest';
import { refreshArcSwapBalances } from './arcSwapBalanceRefresh';

describe('Arc Swap confirmed balance refresh', () => {
  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ])('refreshes both token balances after a recovered confirmation for %s → %s', async () => {
    const refreshInput = vi.fn().mockResolvedValue({ isError: false });
    const refreshOutput = vi.fn().mockResolvedValue({ isError: false });

    await expect(refreshArcSwapBalances(refreshInput, refreshOutput)).resolves.toBe(false);

    expect(refreshInput).toHaveBeenCalledOnce();
    expect(refreshOutput).toHaveBeenCalledOnce();
  });

  it('reports a failed balance refresh instead of hiding it', async () => {
    await expect(refreshArcSwapBalances(
      async () => ({ isError: true }),
      async () => ({ isError: false }),
    )).resolves.toBe(true);
  });
});
