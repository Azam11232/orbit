import { describe, expect, it } from 'vitest';
import { arcTestnet, base } from 'wagmi/chains';
import { ARC_USDC } from '../data/tokens';
import { buildErc20TransferData, isArcUsdcAsset, isUserRejectedError, validateSendRequest } from './useSendTransaction';

const wallet = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const recipient = '0x2222222222222222222222222222222222222222';

describe('Arc send safety', () => {
  it('accepts only the official Arc USDC asset', () => {
    expect(isArcUsdcAsset(ARC_USDC)).toBe(true);
    expect(isArcUsdcAsset({ ...ARC_USDC, address: '0x3333333333333333333333333333333333333333' })).toBe(false);
    expect(ARC_USDC.chainId).toBe(arcTestnet.id);
  });

  it('rejects invalid, zero, negative, over-precision, self, and insufficient amounts', () => {
    const baseRequest = { address: wallet, balance: 1_000_000n, decimals: 6 };
    expect(validateSendRequest({ ...baseRequest, recipient: '', amount: '1' })).toContain('valid');
    expect(validateSendRequest({ ...baseRequest, recipient, amount: '0' })).toContain('greater than zero');
    expect(validateSendRequest({ ...baseRequest, recipient, amount: '-1' })).toContain('valid amount');
    expect(validateSendRequest({ ...baseRequest, recipient, amount: '1.0000001' })).toContain('valid amount');
    expect(validateSendRequest({ ...baseRequest, recipient: wallet, amount: '1' })).toContain('not your own');
    expect(validateSendRequest({ ...baseRequest, recipient, amount: '2' })).toContain('Insufficient');
  });

  it('preserves six-decimal bigint precision', () => {
    expect(validateSendRequest({ address: wallet, recipient, amount: '1.000001', balance: 1_000_001n, decimals: 6 })).toBeNull();
  });

  it('builds ERC-20 transfer calldata for the fixed Arc token target', () => {
    expect(buildErc20TransferData(recipient, 1_000_000n)).toMatch(/^0xa9059cbb/);
    expect(ARC_USDC.address).toBe('0x3600000000000000000000000000000000000000');
  });

  it('classifies wallet rejection separately from transaction failure', () => {
    expect(isUserRejectedError(new Error('User rejected the request'))).toBe(true);
    expect(isUserRejectedError(new Error('RPC unavailable'))).toBe(false);
  });

  it('keeps Base as a separate chain from Arc', () => {
    expect(base.id).not.toBe(arcTestnet.id);
  });
});