import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Users, UserPlus, Settings2, User, type LucideIcon } from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

interface BottomNavProps {
  onNavigate?: (to: string) => void;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/groups', label: 'Groups', icon: Users },
  { to: '/friends', label: 'Friends', icon: UserPlus },
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/profile', label: 'Profile', icon: User },
];

export function BottomNav({ onNavigate }: BottomNavProps) {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Main navigation"
      className="argus-floating-mobile-bottom pointer-events-none absolute inset-x-0 z-30 px-2 pb-2 pt-1 lg:static lg:shrink-0 lg:pb-[calc(env(safe-area-inset-bottom)_+_1.5rem)]"
    >
      <div className="pointer-events-auto mx-auto flex w-fit items-center justify-center gap-2 rounded-2xl bg-[#12121a]/95 p-1 shadow-[0_-2px_24px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08] backdrop-blur-xl">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const active = pathname === to || (pathname.startsWith(to + '/') && to !== '/');
          return (
            <Link
              key={to}
              to={to}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              onClick={
                onNavigate && !active
                  ? (e) => {
                      e.preventDefault();
                      onNavigate(to);
                    }
                  : undefined
              }
              className={`flex flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 transition-colors duration-200 ${
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
