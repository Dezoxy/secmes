import { useState, useEffect, useCallback } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Fingerprint, RefreshCw } from 'lucide-react';
import { useAuth } from './features/auth/AuthContext';
import { ArgusAppIcon } from './features/brand/ArgusAppIcon';
import { usePwaUpdate } from './features/pwa/PwaUpdateContext';
import AuthCallbackRoute from './routes/AuthCallbackRoute';
import ChatRoute from './routes/ChatRoute';
import DevicesRoute from './routes/DevicesRoute';
import SecurityRoute from './routes/SecurityRoute';
import SettingsRoute from './routes/SettingsRoute';
import StorageRoute from './routes/StorageRoute';

/**
 * Landing / sign-in screen. Argus exposes one primary passkey entry point and delegates login,
 * registration, and recovery choices to Zitadel. No password ever reaches our server, which stays
 * crypto-blind. When OIDC isn't configured (VITE_OIDC_* unset), actions drop into the seed-driven
 * demo at /chat.
 *
 * Carousel slides are LOCAL bundled assets (public/images) — no external image requests.
 */
const slides = [
  { image: '/images/login-slide-1.png', title: 'Connect Instantly,', subtitle: 'Message Securely' },
  { image: '/images/login-slide-2.png', title: 'Private by Design,', subtitle: 'Built for Trust' },
  { image: '/images/login-slide-3.png', title: 'Your Conversations,', subtitle: 'Your Control' },
];

function LandingRoute() {
  const { configured, ready, user, login } = useAuth();
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);
  const currentSlide = slides[activeSlide] ?? slides[0]!;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const interval = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [mounted]);

  const goToSlide = useCallback((index: number) => setActiveSlide(index), []);

  // Start OIDC login, or (demo mode, no OIDC) jump straight to the seed-driven chat.
  const handleLogin = () => {
    if (configured) void login();
    else navigate('/chat');
  };

  // Already signed in → skip the landing.
  if (ready && configured && user) return <Navigate to="/chat" replace />;

  return (
    <main
      aria-label="Argus sign-in"
      className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4"
    >
      <section
        aria-label="Passkey sign-in"
        className={`flex h-[90vh] max-h-[900px] w-full max-w-[430px] flex-col overflow-hidden rounded-3xl bg-[#12121a] shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#0f0f16] p-5 sm:p-6">
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
              className={`mx-auto mb-8 max-w-[18rem] text-base leading-relaxed text-white/40 transition-all duration-500 delay-[350ms] ${
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
            </div>

            <p
              className={`mt-8 text-center text-xs text-white/30 transition-all duration-500 delay-[600ms] ${
                mounted ? 'opacity-100' : 'opacity-0'
              }`}
            >
              By continuing, you agree to our{' '}
              <a
                href="#"
                className="text-purple-400 underline underline-offset-2 transition-colors duration-300 hover:text-purple-300"
              >
                Terms of Service
              </a>{' '}
              and{' '}
              <a
                href="#"
                className="text-purple-400 underline underline-offset-2 transition-colors duration-300 hover:text-purple-300"
              >
                Privacy Policy
              </a>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function RouteUpdateAction() {
  const { pathname } = useLocation();
  const { updateReady, applyUpdate } = usePwaUpdate();

  if (!updateReady || pathname === '/chat') return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
      <button
        type="button"
        onClick={() => void applyUpdate()}
        aria-label="Update Argus"
        className="inline-flex h-10 items-center gap-2 rounded-full border border-purple-400/40 bg-[#2b123d]/95 px-4 text-sm font-semibold text-white shadow-2xl shadow-black/35 backdrop-blur transition-all duration-200 hover:border-purple-300/70 hover:bg-[#37164f] active:scale-95"
      >
        <RefreshCw className="h-4 w-4" />
        Update
      </button>
    </div>
  );
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<LandingRoute />} />
        <Route path="/chat" element={<ChatRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/security" element={<SecurityRoute />} />
        <Route path="/devices" element={<DevicesRoute />} />
        <Route path="/storage" element={<StorageRoute />} />
        <Route path="/auth/callback" element={<AuthCallbackRoute />} />
      </Routes>
      <RouteUpdateAction />
    </>
  );
}
