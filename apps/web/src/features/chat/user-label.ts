interface ContactIdentity {
  userId: string;
  argusId?: string | null;
  displayName?: string | null;
}

function cleanDisplayName(user: ContactIdentity): string {
  return user.displayName?.trim() ?? '';
}

export function contactDisplayName(user: ContactIdentity): string {
  return cleanDisplayName(user) || 'Anonymous contact';
}

export function contactSearchText(user: ContactIdentity): string {
  return [cleanDisplayName(user), user.argusId ?? user.userId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
