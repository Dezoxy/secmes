import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Command, Search, X } from 'lucide-react';
import { v2ClassNames } from '../design/tokens';
import {
  v2CommandActions,
  v2CommandHint,
  v2NavItems,
  v2RouteSketches,
  type V2CommandAction,
} from '../mocks/sketch-data';

interface V2ShellProps {
  active: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  aside?: ReactNode;
  commandPreview?: boolean;
}

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function V2Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'verified' | 'warning';
}) {
  const toneClass =
    tone === 'verified'
      ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
      : tone === 'warning'
        ? 'border-amber-300/20 bg-amber-300/10 text-amber-200'
        : 'border-white/[0.08] bg-white/[0.04] text-white/62';

  return (
    <span
      className={joinClasses(
        'inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
        toneClass,
      )}
    >
      {children}
    </span>
  );
}

export function V2CommandBar({
  placeholder = v2CommandHint.label,
  onOpen,
}: {
  placeholder?: string;
  onOpen?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open v2 command palette"
      className={joinClasses(
        'flex h-11 min-w-0 items-center gap-3 rounded-xl px-3.5 text-left transition-colors hover:bg-[#151a20]',
        v2ClassNames.panel,
        v2ClassNames.focus,
      )}
    >
      <Search className="h-4 w-4 shrink-0 text-white/36" />
      <span className="min-w-0 flex-1 truncate text-sm text-white/52">{placeholder}</span>
      <kbd className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/38">
        ⌘K
      </kbd>
    </button>
  );
}

function V2CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const actions = useMemo<Array<V2CommandAction>>(
    () => [
      ...v2RouteSketches.map(({ label, icon, path, id }) => ({
        label: `Open ${label}`,
        hint: path,
        icon,
        target: `/v2/${id}`,
      })),
      ...v2CommandActions,
    ],
    [],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(normalized) ||
        action.hint.toLowerCase().includes(normalized),
    );
  }, [actions, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  const go = (target: string) => {
    navigate(target);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/45 px-4 py-20 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="V2 command palette"
      onClick={onClose}
    >
      <div
        className="mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-white/[0.09] bg-[#151a20] shadow-2xl shadow-black/40"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
          <Command className="h-4 w-4 text-teal-200" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages, conversations, and actions"
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/36"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close command palette"
            className={joinClasses(
              'rounded-lg p-1.5 text-white/42 hover:bg-white/[0.05] hover:text-white/70',
              v2ClassNames.focus,
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[26rem] overflow-y-auto p-2">
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-white/42">No matching action.</div>
          )}
          {filtered.map(({ label, hint, icon: Icon, target }) => (
            <button
              key={`${label}-${target}`}
              type="button"
              onClick={() => go(target)}
              className={joinClasses(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]',
                v2ClassNames.focus,
              )}
            >
              <Icon className="h-4 w-4 text-white/38" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-white/82">{label}</span>
                <span className="mt-0.5 block truncate text-xs text-white/36">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function V2SketchShell({
  active,
  title,
  subtitle,
  children,
  aside,
  commandPreview = false,
}: V2ShellProps) {
  const navigate = useNavigate();
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    const openCommand = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    document.addEventListener('keydown', openCommand);
    return () => document.removeEventListener('keydown', openCommand);
  }, []);

  return (
    <section className={v2ClassNames.page} aria-label={`${title} v2 sketch`}>
      <div className="grid min-h-screen grid-cols-1 md:grid-cols-[4.5rem_minmax(0,1fr)]">
        <nav
          aria-label="V2 primary"
          className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-white/[0.07] bg-[#090b0e]/95 px-4 py-3 backdrop-blur md:static md:flex-col md:justify-start md:border-b-0 md:border-r md:px-3 md:py-5"
        >
          <button
            type="button"
            onClick={() => navigate('/v2')}
            aria-label="Open v2 sketchbook"
            className={joinClasses(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-sm font-semibold text-white md:mb-2',
              v2ClassNames.focus,
            )}
          >
            A
          </button>
          <div className="flex items-center gap-2 md:flex-col md:gap-4">
            {v2NavItems.map(({ id, label, icon: Icon, target }) => {
              const selected = id === active;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => navigate(target)}
                  aria-label={label}
                  aria-current={selected ? 'page' : undefined}
                  className={joinClasses(
                    'flex h-10 w-10 items-center justify-center rounded-xl transition-colors',
                    selected
                      ? 'bg-teal-300/12 text-teal-200'
                      : 'text-white/36 hover:bg-white/[0.04] hover:text-white/70',
                    v2ClassNames.focus,
                  )}
                >
                  <Icon className="h-4.5 w-4.5" />
                </button>
              );
            })}
          </div>
        </nav>

        <div className="flex min-w-0 flex-col">
          <header className="flex min-h-20 flex-col items-stretch gap-4 border-b border-white/[0.07] px-4 py-4 md:flex-row md:items-center md:px-6 md:py-0">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-white/36">
                ARGUS v2
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2 md:gap-3">
                <h1 className="min-w-0 text-base font-semibold text-white md:text-lg">{title}</h1>
                <V2Badge tone="verified">
                  <Check className="h-3.5 w-3.5" />
                  Verified
                </V2Badge>
                <V2Badge>MLS</V2Badge>
              </div>
              {subtitle && <p className="mt-1 text-sm text-white/46">{subtitle}</p>}
            </div>
            <div className="lg:hidden">
              <V2CommandBar onOpen={() => setCommandOpen(true)} />
            </div>
            <div className="hidden w-full max-w-xl lg:block">
              <V2CommandBar onOpen={() => setCommandOpen(true)} />
            </div>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <main className="min-w-0 overflow-x-hidden overflow-y-auto">{children}</main>
            {aside && (
              <aside className="hidden border-l border-white/[0.07] bg-[#0d1014] p-4 xl:block">
                {aside}
              </aside>
            )}
          </div>
        </div>
      </div>

      <V2CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />

      {commandPreview && (
        <div className="fixed left-1/2 top-24 hidden w-full max-w-xl -translate-x-1/2 rounded-2xl border border-white/[0.08] bg-[#151a20]/95 p-2 shadow-2xl shadow-black/30 backdrop-blur md:block">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-sm text-white/54">
            <Command className="h-4 w-4" />
            <span>{v2CommandHint.label}</span>
          </div>
          <div className="py-1">
            {v2CommandActions.slice(0, 3).map(({ label, hint, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={() => setCommandOpen(true)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-white/[0.04]"
              >
                <Icon className="h-4 w-4 text-white/36" />
                <span className="flex-1 text-sm text-white/80">{label}</span>
                <span className="text-xs text-white/36">{hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function V2AsidePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </div>
  );
}

export function V2FactRow({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'verified' | 'warning';
}) {
  const dotClass =
    tone === 'verified' ? 'bg-emerald-300' : tone === 'warning' ? 'bg-amber-300' : 'bg-white/30';

  return (
    <div className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
      <span className={joinClasses('mt-1 h-2 w-2 rounded-full', dotClass)} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-white/86">{label}</p>
        <p className="mt-0.5 text-xs leading-5 text-white/45">{value}</p>
      </div>
    </div>
  );
}
