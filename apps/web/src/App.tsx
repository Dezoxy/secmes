import { useState, useEffect, useCallback } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Fingerprint, MessageCircle } from 'lucide-react';
import { useAuth } from './features/auth/AuthContext';
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
    <div className="min-h-screen bg-[#1a1a24] flex items-center justify-center p-4">
      <div
        className={`w-full max-w-4xl bg-[#12121a] rounded-3xl overflow-hidden flex flex-col lg:flex-row shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        {/* Left Panel */}
        <div className="lg:w-[45%] bg-[#0f0f16] p-5 flex flex-col">
          <div
            className={`flex items-center justify-between mb-4 transition-all duration-500 delay-200 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
            }`}
          >
            <div className="text-white text-xl font-bold tracking-wider flex items-center gap-2">
              <div className="w-8 h-8 bg-purple-500 rounded-lg flex items-center justify-center">
                <MessageCircle className="w-4 h-4 text-white" />
              </div>
              <span className="bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
                ARGUS
              </span>
            </div>
          </div>

          {/* Image Carousel */}
          <div
            className={`flex-1 relative rounded-2xl overflow-hidden min-h-[260px] transition-all duration-700 delay-300 ${
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
              <h2 className="text-white text-xl font-semibold leading-tight tracking-tight">
                {currentSlide.title}
                <br />
                {currentSlide.subtitle}
              </h2>
            </div>
          </div>

          {/* Carousel Dots */}
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
        </div>

        {/* Right Panel - Sign-in Options */}
        <div className="lg:w-[55%] p-6 lg:p-8 flex flex-col justify-center">
          <h1
            className={`text-white text-2xl lg:text-3xl font-bold mb-2 tracking-tight transition-all duration-500 delay-300 ${
              mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
            }`}
          >
            Welcome to Argus
          </h1>
          <p
            className={`text-white/40 text-sm mb-8 transition-all duration-500 delay-[350ms] ${
              mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
            }`}
          >
            Use your device passkey to open secure messaging
          </p>

          <div>
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
          </div>

          <p
            className={`text-white/30 text-xs text-center mt-8 transition-all duration-500 delay-[600ms] ${
              mounted ? 'opacity-100' : 'opacity-0'
            }`}
          >
            By continuing, you agree to our{' '}
            <a
              href="#"
              className="text-purple-400 underline underline-offset-2 hover:text-purple-300 transition-colors duration-300"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href="#"
              className="text-purple-400 underline underline-offset-2 hover:text-purple-300 transition-colors duration-300"
            >
              Privacy Policy
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route path="/chat" element={<ChatRoute />} />
      <Route path="/settings" element={<SettingsRoute />} />
      <Route path="/security" element={<SecurityRoute />} />
      <Route path="/devices" element={<DevicesRoute />} />
      <Route path="/storage" element={<StorageRoute />} />
      <Route path="/auth/callback" element={<AuthCallbackRoute />} />
    </Routes>
  );
}
