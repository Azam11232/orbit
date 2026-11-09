export type SecurityNavigationAction = 'view-security-details' | 'manage-approvals';
export type SecurityNavigationPage = 'security' | 'approvals';

export function getSecurityNavigationTarget(action: SecurityNavigationAction): SecurityNavigationPage {
  return action === 'view-security-details' ? 'security' : 'approvals';
}
