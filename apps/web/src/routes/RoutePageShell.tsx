import { useCallback, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Database,
  HardDrive,
  MessageSquare,
  Settings,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { ArgusAppIcon } from '../features/brand/ArgusAppIcon';
import { surfaceEnterMotion } from '../features/ui';
import { AuthenticatedRouteBoundary } from './AuthenticatedRouteBoundary';

interface RoutePageShellProps {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}

const navItems = [
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/security', label: 'Security', icon: Shield },
  { to: '/devices', label: 'Devices', icon: HardDrive },
  { to: '/storage', label: 'Storage', icon: Database },
];

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function RoutePageShell({
  eyebrow,
  title,
  description,
  icon: Icon,
  children,
}: RoutePageShellProps) {
  const location = useLocation();
  const navigate = useNavigate();

  // Smart back: only step back when there is genuine in-app history. React Router stamps the first
  // location of a session with key "default"; any in-app navigation produces a unique key. Keying off
  // that (rather than window.history.length, which also counts external/prior-tab entries) keeps deep
  // links, fresh PWA loads, and external referrers landing on /chat instead of navigating off-site.
  const handleBack = useCallback(() => {
    if (location.key !== 'default') {
      navigate(-1);
    } else {
      // No in-app history: replace (don't push) this deep-link entry, otherwise the browser/system Back
      // button from /chat would bounce the user straight back into this guarded route.
      navigate('/chat', { replace: true });
    }
  }, [location.key, navigate]);

  return (
    <AuthenticatedRouteBoundary>
      <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#0c0c12] text-white">
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-y-auto">
          <header className="relative sticky top-0 z-20 flex flex-col gap-4 bg-[#0c0c12]/80 backdrop-blur-xl px-4 pt-[calc(env(safe-area-inset-top)_+_1.25rem)] pb-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-inherit after:backdrop-blur-xl after:content-['']">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleBack}
                aria-label="Go back"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/5 text-white/60 transition-colors hover:bg-white/[0.05] hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <Link to="/chat" className="flex items-center gap-3" aria-label="Open chat">
                <ArgusAppIcon className="h-10 w-10 rounded-xl shadow-lg shadow-[#964cdc]/20" />
                <span className="text-xl font-bold tracking-[0.08em] text-[var(--argus-brand-300)]">
                  ARGUS
                </span>
              </Link>
            </div>

            <nav className="flex gap-1 overflow-x-auto rounded-xl border border-white/5 bg-white/[0.03] p-1">
              {navItems.map(({ to, label, icon: NavIcon }) => {
                const active = location.pathname === to;
                return (
                  <Link
                    key={to}
                    to={to}
                    aria-current={active ? 'page' : undefined}
                    className={joinClasses(
                      'inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors',
                      active
                        ? 'bg-purple-500/20 text-white'
                        : 'text-white/50 hover:bg-white/[0.05] hover:text-white',
                    )}
                  >
                    <NavIcon className="h-4 w-4" />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </nav>
          </header>

          <main
            key={location.pathname}
            className={`flex flex-1 flex-col px-4 py-8 pb-[calc(env(safe-area-inset-bottom)_+_2rem)] sm:px-6 lg:px-8 ${surfaceEnterMotion}`}
          >
            <section className="max-w-3xl">
              <div className="mb-5 flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/15 text-purple-300">
                  <Icon className="h-6 w-6" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/60">
                    {eyebrow}
                  </p>
                  <h1 className="mt-1 text-2xl font-semibold tracking-normal text-white sm:text-3xl">
                    {title}
                  </h1>
                </div>
              </div>
              <p className="max-w-2xl text-sm leading-6 text-white/50">{description}</p>
            </section>

            <div className="mt-8 max-w-3xl">{children}</div>
          </main>
        </div>
      </div>
    </AuthenticatedRouteBoundary>
  );
}
