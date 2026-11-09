import type { Hash } from 'viem';

export interface FreshSendFormState {
  recipient: string;
  amount: string;
  formError: string | null;
  completedAt: number | null;
  showReview: boolean;
}

export function createFreshSendFormState(): FreshSendFormState {
  return {
    recipient: '',
    amount: '',
    formError: null,
    completedAt: null,
    showReview: false,
  };
}

export function shouldShowSendSuccess(input: {
  status: string;
  transactionHash?: Hash;
}) {
  return input.status === 'confirmed' && Boolean(input.transactionHash);
}

export function isCurrentSendFlow(expectedGeneration: number, currentGeneration: number) {
  return expectedGeneration === currentGeneration;
}
