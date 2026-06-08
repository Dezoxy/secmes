import type { UserSummary } from '../../lib/api';

type ContactIdentity = Pick<UserSummary, 'id' | 'displayName'>;

export function contactDisplayName(user: ContactIdentity): string {
  return user.displayName.trim() || 'Anonymous contact';
}

export function contactSearchText(user: ContactIdentity): string {
  return [user.displayName.trim(), user.id].filter(Boolean).join(' ').toLowerCase();
}
