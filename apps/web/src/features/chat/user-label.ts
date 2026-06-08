import type { UserSummary } from '../../lib/api';

type ContactIdentity = Pick<UserSummary, 'id' | 'displayName'>;

function cleanDisplayName(user: ContactIdentity): string {
  return user.displayName?.trim() ?? '';
}

export function contactDisplayName(user: ContactIdentity): string {
  return cleanDisplayName(user) || 'Anonymous contact';
}

export function contactSearchText(user: ContactIdentity): string {
  return [cleanDisplayName(user), user.id].filter(Boolean).join(' ').toLowerCase();
}
