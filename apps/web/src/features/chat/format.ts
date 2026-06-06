// Pure time formatting for the chat UI (no locale deps).

/** Relative-ish label for a conversation's last activity: "Just now", "5m", "3h", "Yesterday", "Jun 4". */
export function formatRelativeTime(epochMs: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - epochMs) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  const d = new Date(epochMs);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

/** Clock time for a message bubble, e.g. "2:05 PM". */
export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes} ${ampm}`;
}
