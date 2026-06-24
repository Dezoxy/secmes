import { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Fingerprint, RefreshCw, X } from 'lucide-react';
import { useAuth } from './features/auth/AuthContext';
import { RegisterScreen } from './features/auth/RegisterScreen';
import { prefersReducedMotion } from './lib/pref';
import { ArgusAppIcon } from './features/brand/ArgusAppIcon';
import { usePwaUpdate } from './features/pwa/PwaUpdateContext';
import { APP_VERSION_TAG } from './lib/app-version';
import { conversationEnterMotion, modalPanelExitMotion, paneBackEnterMotion } from './features/ui';
import ChatRoute from './routes/ChatRoute';
import { useSurfaceBackground } from './lib/use-surface-background';

const DevicesRoute = lazy(() => import('./routes/DevicesRoute'));
const SecurityRoute = lazy(() => import('./routes/SecurityRoute'));
const SettingsRoute = lazy(() => import('./routes/SettingsRoute'));
const StorageRoute = lazy(() => import('./routes/StorageRoute'));
const TransparencyRoute = lazy(() => import('./routes/TransparencyRoute'));
const V2SketchRoute = lazy(() => import('./routes/V2SketchRoute'));
// Admin (breakglass) login lives on its own path, gated by Cloudflare Access in production (Caddy 404s it
// without the Access header). Lazy so the breakglass code stays out of the public landing chunk.
const AdminLoginRoute = lazy(() => import('./routes/AdminLoginRoute'));

const slides = [
  { image: '/images/login-slide-1.png', title: 'Connect Instantly,', subtitle: 'Message Securely' },
  { image: '/images/login-slide-2.png', title: 'Private by Design,', subtitle: 'Built for Trust' },
  { image: '/images/login-slide-3.png', title: 'Your Conversations,', subtitle: 'Your Control' },
];

type Panel = null | 'register';

function LandingRoute() {
  const { ready, profile, demoMode, login } = useAuth();
  const navigate = useNavigate();
  useSurfaceBackground('#0f0f16'); // login card's scroll bg → matches the home-indicator strip
  const [mounted, setMounted] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  // Tracks whether we've returned from a sub-panel (e.g. register) so the passkey view slides back in
  // rather than re-running its first-load fade.
  const [returnedFromPanel, setReturnedFromPanel] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const currentSlide = slides[activeSlide] ?? slides[0]!;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || prefersReducedMotion()) return;
    const interval = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [mounted]);

  const goToSlide = useCallback((index: number) => setActiveSlide(index), []);

  const handleLogin = () => {
    if (demoMode) {
      navigate('/chat');
      return;
    }
    setLoginError(null);
    void login().catch(() => setLoginError('Passkey sign-in failed. Try again.'));
  };

  // Already signed in → skip the landing.
  if (ready && profile) return <Navigate to="/chat" replace />;

  return (
    <main
      aria-label="Argus sign-in"
      className="flex h-[100dvh] items-center justify-center bg-[#1a1a24] sm:p-4"
    >
      <section
        aria-label="Passkey sign-in"
        className={`absolute inset-0 flex w-full flex-col overflow-hidden bg-[#12121a] shadow-2xl shadow-black/50 transition-all duration-700 ease-out sm:static sm:h-[90dvh] sm:max-h-[900px] sm:max-w-[430px] sm:rounded-3xl ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#0f0f16] p-5 pt-[calc(env(safe-area-inset-top)_+_1.25rem)] pb-[calc(env(safe-area-inset-bottom)_+_1.25rem)] sm:p-6">
          {panel === 'register' ? (
            <div
              key="register"
              className={`flex flex-1 flex-col justify-center ${conversationEnterMotion}`}
            >
              <RegisterScreen
                onRegistered={() => navigate('/chat')}
                onBack={() => {
                  setReturnedFromPanel(true);
                  setPanel(null);
                }}
              />
            </div>
          ) : (
            <div
              key="passkey"
              className={`flex min-h-0 flex-1 flex-col ${returnedFromPanel ? paneBackEnterMotion : ''}`}
            >
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
                  <ArgusAppIcon className="h-12 w-12 rounded-2xl shadow-lg shadow-purple-500/25" />
                  <span className="bg-gradient-to-r from-purple-300 to-purple-600 bg-clip-text text-transparent">
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
                  Welcome to Argus
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
                    onClick={handleLogin}
                    className="w-full flex items-center justify-center gap-3 bg-purple-500 hover:bg-purple-400 text-white font-medium py-3 rounded-xl transition-all duration-300 text-sm shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:-translate-y-0.5 active:translate-y-0 active:shadow-purple-500/20"
                  >
                    <Fingerprint className="w-5 h-5" />
                    Continue with passkey
                  </button>

                  {loginError && <p className="mt-2 text-xs text-red-400">{loginError}</p>}

                  <button
                    type="button"
                    onClick={() => setPanel('register')}
                    className="mt-3 w-full rounded-xl border border-white/5 py-2.5 text-sm text-white/50 transition-colors hover:border-purple-500/30 hover:text-white/80"
                  >
                    I have an invite code →
                  </button>
                </div>

                <div
                  className={`mt-8 flex flex-col items-center gap-2 text-center transition-all duration-500 delay-[600ms] ${
                    mounted ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <p className="text-xs text-white/60">
                    By continuing, you agree to our{' '}
                    <span
                      aria-disabled="true"
                      className="text-purple-400 underline underline-offset-2"
                    >
                      Terms of Service
                    </span>{' '}
                    and{' '}
                    <span
                      aria-disabled="true"
                      className="text-purple-400 underline underline-offset-2"
                    >
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
          )}
        </div>
      </section>
    </main>
  );
}

function RouteUpdateAction() {
  const { pathname } = useLocation();
  const { updateReady, applyUpdate, newVersion, dialogOpen, openUpdateDialog, closeUpdateDialog } =
    usePwaUpdate();
  const [applying, setApplying] = useState(false);
  const [closing, setClosing] = useState(false);

  // Chat has its own sidebar update buttons — skip the global pill to avoid duplicates.
  if (!updateReady || pathname === '/chat') return null;

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      closeUpdateDialog();
    }, 220);
  };

  if (!dialogOpen) {
    return (
      <div className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
        <button
          type="button"
          onClick={openUpdateDialog}
          aria-label="Update Argus"
          className="inline-flex h-10 items-center gap-2 rounded-full border border-purple-400/40 bg-[#2b123d]/95 px-4 text-sm font-semibold text-white shadow-2xl shadow-black/35 backdrop-blur transition-all duration-200 hover:border-purple-300/70 hover:bg-[#37164f] active:scale-95"
        >
          <RefreshCw className="h-4 w-4" />
          Update
        </button>
      </div>
    );
  }

  const handleUpdate = async () => {
    setApplying(true);
    try {
      await applyUpdate();
    } catch {
      setApplying(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
      <div
        role="dialog"
        aria-label="Update available"
        className={`w-72 rounded-2xl border border-purple-400/40 bg-[#2b123d]/95 p-4 shadow-2xl shadow-black/35 backdrop-blur sm:w-80 ${closing ? modalPanelExitMotion : 'argus-surface-enter'}`}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Update available</span>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="rounded-md p-1 text-white/50 transition-colors hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 space-y-1.5 rounded-lg bg-white/5 px-3 py-2.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-white/50">Running</span>
            <span className="font-mono font-medium text-white">{APP_VERSION_TAG}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/50">Update</span>
            {newVersion ? (
              <span className="font-mono font-medium text-purple-300">{newVersion}</span>
            ) : (
              <span className="animate-pulse font-mono text-white/30">fetching…</span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void handleUpdate()}
          disabled={applying}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-purple-400/40 bg-purple-600/30 px-4 py-2 text-sm font-semibold text-white transition-all hover:border-purple-300/70 hover:bg-purple-600/50 active:scale-95 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${applying ? 'animate-spin' : ''}`} />
          {applying ? 'Restarting…' : 'Update Argus'}
        </button>
      </div>
    </div>
  );
}

function RouteLoadingFallback() {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-[#1a1a24] p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] text-sm text-white/50">
      Loading...
    </div>
  );
}

export default function App() {
  return (
    <>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="/" element={<LandingRoute />} />
          <Route path="/chat" element={<ChatRoute />} />
          <Route path="/settings" element={<SettingsRoute />} />
          <Route path="/security" element={<SecurityRoute />} />
          <Route path="/devices" element={<DevicesRoute />} />
          <Route path="/storage" element={<StorageRoute />} />
          <Route path="/transparency" element={<TransparencyRoute />} />
          <Route path="/admin" element={<AdminLoginRoute />} />
          <Route path="/v2" element={<V2SketchRoute />} />
          <Route path="/v2/:sketchId" element={<V2SketchRoute />} />
        </Routes>
      </Suspense>
      <RouteUpdateAction />
    </>
  );
}
