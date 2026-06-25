import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Users, UserPlus, Settings2, User, type LucideIcon } from 'lucide-react';
import { useFloatingClearance } from './useFloatingClearance';

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
];
const PROFILE_NAV_ITEM: NavItem = { to: '/profile', label: 'Profile', icon: User };

const ALL_TAB_ITEMS = [...NAV_ITEMS, PROFILE_NAV_ITEM];

export function BottomNav({ onNavigate }: BottomNavProps) {
  const { pathname } = useLocation();

  // Reserve only the floating pills' real height (+ offset + gap) as scroll clearance, so content
  // fills the bottom edge-to-edge instead of leaving a reserved dead band below the bar. The nav is
  // fixed-height and only hides transiently (conversation view), so keep the last value on unmount.
  const setNavClearance = useFloatingClearance('--argus-floating-mobile-nav-clearance', {
    keepLastOnUnmount: true,
  });

  return (
    <nav
      ref={setNavClearance}
      aria-label="Main navigation"
      className="argus-floating-mobile-bottom pointer-events-none absolute inset-x-0 z-30 px-2 pb-2 pt-1 lg:static lg:shrink-0 lg:pb-[calc(env(safe-area-inset-bottom)_+_1.5rem)]"
    >
      <div className="pointer-events-auto mx-auto flex w-fit items-stretch justify-center gap-4">
        <div className="flex items-center justify-center gap-2 rounded-2xl bg-[#12121a]/95 p-1 shadow-[0_-2px_24px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08] backdrop-blur-xl">
          {NAV_ITEMS.map((item) => (
            <BottomNavLink key={item.to} item={item} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </div>
        <div className="flex items-center justify-center rounded-full bg-[#12121a]/95 p-1 shadow-[0_-2px_24px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08] backdrop-blur-xl">
          <BottomNavLink
            item={PROFILE_NAV_ITEM}
            pathname={pathname}
            onNavigate={onNavigate}
            className="h-14 w-14 justify-center rounded-full p-0"
            iconClassName="h-6 w-6"
            labelClassName="sr-only"
          />
        </div>
      </div>
    </nav>
  );
}

function BottomNavLink({
  item: { to, label, icon: Icon },
  pathname,
  onNavigate,
  className,
  iconClassName,
  labelClassName,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: (to: string) => void;
  className?: string;
  iconClassName?: string;
  labelClassName?: string;
}) {
  const active = pathname === to || (pathname.startsWith(to + '/') && to !== '/');

  return (
    <Link
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
      className={`flex flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 transition-colors duration-200 ${className ?? ''} ${
        active
          ? 'bg-[#1e1e2e] text-purple-300'
          : 'text-white/45 hover:bg-white/[0.04] hover:text-white/70'
      }`}
    >
      <Icon className={iconClassName ?? 'h-5 w-5'} />
      <span className={labelClassName ?? 'text-[10px] font-medium leading-none'}>{label}</span>
    </Link>
  );
}

export const TAB_PATHS = ALL_TAB_ITEMS.map((item) => item.to);
