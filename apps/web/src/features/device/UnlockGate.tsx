import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';

import { Fingerprint, Loader2, Lock, UserCog } from 'lucide-react';
import { Link } from 'react-router-dom';

import { ArgusAppIcon } from '../brand/ArgusAppIcon';
import { prefersReducedMotion } from '../../lib/pref';
import { hasPendingUnlockKey } from '../../lib/prf';
import { useDevice } from './DeviceContext';

// Gates the chat on an unlocked MLS device. The device keys are sealed at rest under the passkey-PRF unlock
// key (no passphrase) — unlock is automatic when the login/registration ceremony already produced the key,
// and one tap (a fresh passkey assertion) on reload. There is NO recovery: a lost passkey / wiped browser is
// a fresh start (ask your admin for a new registration code). A SWITCH path handles a browser already holding
// a different account's device (single slot, v1). The breakglass admin and demo mode short-circuit ('ready').

const CARD = 'm-auto w-full max-w-sm rounded-3xl bg-[#12121a] p-8 shadow-2xl shadow-black/50';
const PRIMARY =
  'flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--argus-brand-400)] py-3 text-sm font-medium text-white shadow-lg shadow-[#783db0]/25 transition-all hover:bg-[var(--argus-brand-300)] disabled:cursor-not-allowed disabled:opacity-40';

const slides = [
  { image: '/images/login-slide-1.png', title: 'Connect Instantly,', subtitle: 'Message Securely' },
  { image: '/images/login-slide-2.png', title: 'Private by Design,', subtitle: 'Built for Trust' },
  { image: '/images/login-slide-3.png', title: 'Your Conversations,', subtitle: 'Your Control' },
];

export function UnlockGate({ children }: { children: ReactNode }): ReactNode {
  const { status, error, unlock, resetForNewAccount } = useDevice();
  const autoTried = useRef(false);

  const creating = status === 'needs-create';
  const busy = status === 'unlocking' || status === 'loading';

  const [mounted, setMounted] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);
  const currentSlide = slides[activeSlide] ?? slides[0]!;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || prefersReducedMotion() || status === 'ready') return;
    const interval = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [mounted, status]);

  const goToSlide = useCallback((index: number) => setActiveSlide(index), []);

  // Auto-unlock with no prompt ONLY when the login/registration ceremony already stashed the unlock key — a
  // fresh assertion needs a user gesture, so on reload (no stashed key) we wait for the button click below.
  useEffect(() => {
    if (autoTried.current || error) return;
    if (status !== 'needs-unlock' && status !== 'needs-create') return;
    if (!hasPendingUnlockKey()) return;
    autoTried.current = true;
    void unlock();
  }, [status, error, unlock]);

  if (status === 'ready') return <>{children}</>;

  const cardShell = (
    icon: ReactNode,
    title: string,
    subtitle: string,
    body: ReactNode,
  ): ReactNode => (
    <div className="flex h-[100dvh] flex-col overflow-y-auto bg-[#1a1a24] px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)_+_1rem)]">
      <div className={CARD}>
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--argus-brand-400)]/20">
            {icon}
          </div>
          <h1 className="text-lg font-semibold text-white">{title}</h1>
          <p className="mt-1 text-sm text-white/60">{subtitle}</p>
        </div>
        {body}
      </div>
    </div>
  );

  // No PRF on this authenticator (or the keystore can't be opened) — there is no recovery path.
  if (status === 'error') {
    return cardShell(
      <Lock className="h-6 w-6 text-[var(--argus-brand-300)]" />,
      "This device can't be used",
      "Your passkey can't unlock secure messaging on this device. Ask your admin for a new registration code to start fresh.",
      <>{error && <p className="text-center text-xs text-red-400/80">{error}</p>}</>,
    );
  }

  if (status === 'needs-switch') {
    return cardShell(
      <UserCog className="h-6 w-6 text-[var(--argus-brand-300)]" />,
      'Different account on this device',
      "This browser is set up for another Argus account. Set up your account here — this replaces the other account's device, and there is no way to restore it (lost access means a new registration code from your admin).",
      <div className="space-y-3">
        {error && <p className="text-xs text-red-400/80">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void resetForNewAccount()}
          className={PRIMARY}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Set up my account here
        </button>
      </div>,
    );
  }

  // needs-unlock / needs-create — full landing-style layout with a single unlock button.
  return (
    <main
      aria-label="Argus unlock"
      className="flex h-[100dvh] items-center justify-center bg-[#1a1a24] sm:p-4"
    >
      <section
        aria-label="Passkey unlock"
        className={`absolute inset-0 flex w-full flex-col overflow-hidden bg-[#12121a] shadow-2xl shadow-black/50 transition-all duration-700 ease-out sm:static sm:h-[90dvh] sm:max-h-[900px] sm:max-w-[430px] sm:rounded-3xl ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#0f0f16] p-5 pt-[calc(env(safe-area-inset-top)_+_1.25rem)] pb-[calc(env(safe-area-inset-bottom)_+_1.25rem)] sm:p-6">
          <div
            className={`mb-5 flex items-center justify-center text-center transition-all duration-500 delay-200 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
            }`}
          >
            <div
              role="group"
              aria-label="Argus brand"
              className="flex items-center justify-center gap-3 text-3xl font-bold tracking-[0.12em] text-white"
            >
              <ArgusAppIcon className="h-12 w-12 rounded-2xl shadow-lg shadow-[#783db0]/25" />
              <span className="bg-gradient-to-r from-[var(--argus-brand-300)] to-[var(--argus-brand-600)] bg-clip-text text-transparent">
                ARGUS
              </span>
            </div>
          </div>

          <div
            className={`relative aspect-[3/2] shrink-0 overflow-hidden rounded-2xl transition-all duration-700 delay-300 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
            }`}
          >
            {slides.map((slide, index) => (
              <div
                key={index}
                className={`absolute inset-0 transition-all duration-700 ease-in-out ${
                  index === activeSlide ? 'opacity-100 scale-100' : 'opacity-0 scale-105'
                }`}
              >
                <img
                  src={slide.image}
                  alt={`${slide.title} ${slide.subtitle}`}
                  className="absolute inset-0 h-full w-full object-cover"
                  loading={index === 0 ? 'eager' : 'lazy'}
                />
              </div>
            ))}

            <div className="absolute inset-0 bg-gradient-to-t from-[#0f0f16] via-[#0f0f16]/20 to-transparent" />

            <div
              className={`absolute bottom-6 left-0 right-0 text-center px-4 transition-all duration-500 delay-500 ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h2 className="text-xl font-semibold leading-tight tracking-tight text-white">
                {currentSlide.title}
                <br />
                {currentSlide.subtitle}
              </h2>
            </div>
          </div>

          <div
            className={`flex items-center justify-center gap-1.5 mt-4 transition-all duration-500 delay-[600ms] ${
              mounted ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {slides.map((_, index) => (
              <button
                key={index}
                onClick={() => goToSlide(index)}
                className={`h-0.5 rounded-full transition-all duration-300 ${
                  index === activeSlide ? 'w-6 bg-white' : 'w-3 bg-white/20 hover:bg-white/40'
                }`}
                aria-label={`Go to slide ${index + 1}`}
              />
            ))}
          </div>

          <div className="flex flex-1 flex-col justify-center py-6 text-center">
            <h1
              className={`mb-3 text-3xl font-bold tracking-tight text-white transition-all duration-500 delay-300 ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              Welcome back
            </h1>
            <p
              className={`mx-auto mb-8 max-w-[18rem] text-base leading-relaxed text-white/60 transition-all duration-500 delay-[350ms] ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              Use your device passkey to open secure messaging
            </p>

            <div
              className={`transition-all duration-500 delay-[400ms] ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => void unlock()}
                className="w-full flex items-center justify-center gap-3 bg-[var(--argus-brand-400)] hover:bg-[var(--argus-brand-300)] text-white font-medium py-3 rounded-xl transition-all duration-300 text-sm shadow-lg shadow-[#783db0]/25 hover:shadow-[#783db0]/40 hover:-translate-y-0.5 active:translate-y-0 active:shadow-[#783db0]/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Fingerprint className="w-5 h-5" />
                )}
                {busy ? 'Working…' : creating ? 'Set up this device' : 'Unlock'}
              </button>

              {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
            </div>

            <div
              className={`mt-8 flex flex-col items-center gap-2 text-center transition-all duration-500 delay-[600ms] ${
                mounted ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <p className="text-xs text-white/60">
                By continuing, you agree to our{' '}
                <span aria-disabled="true" className="text-[var(--argus-brand-300)] underline underline-offset-2">
                  Terms of Service
                </span>{' '}
                and{' '}
                <span aria-disabled="true" className="text-[var(--argus-brand-300)] underline underline-offset-2">
                  Privacy Policy
                </span>
              </p>
              <Link
                to="/transparency"
                className="text-xs text-white/40 transition-colors hover:text-white/70"
              >
                Security &amp; transparency ↗
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
