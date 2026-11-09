import { describe, expect, it } from 'vitest';
import { formatArcSwapQuoteDetails } from './quotePresentation';

describe('Arc Swap quote presentation', () => {
  it('uses the SDK output tokens and human-readable output and minimum amounts', () => {
    const details = formatArcSwapQuoteDetails({
      estimatedOutput: { amount: '9.876543', token: 'EURC' },
      stopLimit: { amount: '9.827160', token: 'EURC' },
      fees: [],
      route: {
        provider: 'lifi',
        steps: [{
          type: 'swap',
          tool: 'fly',
          toolName: 'Fly',
          fromToken: { address: '0x1111111111111111111111111111111111111111', symbol: 'USDC', decimals: 6 },
          toToken: { address: '0x2222222222222222222222222222222222222222', symbol: 'EURC', decimals: 6 },
          estimate: { fromAmount: '1000000', toAmount: '9876543' },
        }],
      },
    }, 50);

    expect(details).toEqual({
      route: 'LI.FI · Fly',
      expectedOutput: '9.876543 EURC',
      minimumReceived: '9.827160 EURC',
      providerFees: 'Not provided by route',
      estimatedGas: 'Unavailable',
      slippage: '0.50%',
    });
  });

  it('shows each SDK fee component in its own token and decimal units', () => {
    const details = formatArcSwapQuoteDetails({
      estimatedOutput: { amount: '1.25', token: 'USDC' },
      stopLimit: { amount: '1.24', token: 'USDC' },
      fees: [
        { type: 'provider', amount: '0.01', token: 'EURC' },
        { type: 'swap', amount: '0.0025', token: 'USDC' },
        { type: 'gas', amount: null, token: 'ARC' },
      ],
    }, 100);

    expect(details.expectedOutput).toBe('1.25 USDC');
    expect(details.route).toBe('Unavailable');
    expect(details.minimumReceived).toBe('1.24 USDC');
    expect(details.providerFees).toBe('provider: 0.01 EURC, swap: 0.0025 USDC');
    expect(details.estimatedGas).toBe('Unavailable (ARC)');
    expect(details.slippage).toBe('1.00%');
  });
});
