import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Users, UserPlus, Settings2, User, type LucideIcon } from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/groups', label: 'Groups', icon: Users },
  { to: '/friends', label: 'Friends', icon: UserPlus },
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/profile', label: 'Profile', icon: User },
];

export function BottomNav() {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Main navigation"
      className="shrink-0 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-1"
    >
      <div className="mx-auto flex max-w-md items-center justify-around rounded-2xl bg-[#12121a] p-1.5 shadow-[0_-2px_24px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08]">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const active = pathname === to || (pathname.startsWith(to + '/') && to !== '/');
          return (
            <Link
              key={to}
              to={to}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 rounded-xl px-3 py-2 transition-colors duration-200 ${
                active
                  ? 'bg-[#1e1e2e] text-purple-300'
                  : 'text-white/45 hover:bg-white/[0.04] hover:text-white/70'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export const TAB_PATHS = NAV_ITEMS.map((item) => item.to);
