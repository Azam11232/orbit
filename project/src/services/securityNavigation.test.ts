import { describe, expect, it, vi } from 'vitest';
import { getSecurityNavigationTarget } from './securityNavigation';

describe('security navigation', () => {
  it('routes Home security details through Security Center to Approvals & Revoke', () => {
    const setPage = vi.fn();

    setPage(getSecurityNavigationTarget('view-security-details'));
    setPage(getSecurityNavigationTarget('manage-approvals'));

    expect(setPage.mock.calls).toEqual([['security'], ['approvals']]);
  });
});
