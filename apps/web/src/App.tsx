import { useState, useEffect, useCallback } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { MessageCircle, Fingerprint } from 'lucide-react';
import { useAuth } from './features/auth/AuthContext';

/**
 * Landing / sign-in screen — ported from the reworked design (`~/Downloads`). No registration form:
 * Zitadel hosts credential entry, so the three buttons just start the OIDC redirect (Authorization
 * Code + PKCE) — no password ever reaches our server, which stays crypto-blind. When OIDC isn't
 * configured (VITE_OIDC_* unset) they drop into the seed-driven demo at /chat.
 *
 * Carousel slides are LOCAL bundled assets (public/images) — no external image requests.
 */
const slides = [
  { image: '/images/login-slide-1.png', title: 'Connect Instantly,', subtitle: 'Message Securely' },
  { image: '/images/login-slide-2.png', title: 'Private by Design,', subtitle: 'Built for Trust' },
  { image: '/images/login-slide-3.png', title: 'Your Conversations,', subtitle: 'Your Control' },
];

export default function App() {
  const { configured, ready, user, login } = useAuth();
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);

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
              {slides.map((slide, index) => (
                <h2
                  key={index}
                  className={`text-white text-xl font-semibold leading-tight tracking-tight absolute inset-x-0 bottom-0 transition-all duration-500 ${
                    index === activeSlide ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
                  }`}
                >
                  {slide.title}
                  <br />
                  {slide.subtitle}
                </h2>
              ))}
              <h2 className="text-white text-xl font-semibold leading-tight tracking-tight invisible">
                {slides[0]?.title}
                <br />
                {slides[0]?.subtitle}
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
            Sign in securely to start messaging
          </p>

          <div className="space-y-3">
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
                Continue with Passkey
              </button>
            </div>

            <div
              className={`flex items-center gap-3 py-3 transition-all duration-500 delay-[450ms] ${
                mounted ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              <span className="text-white/30 text-xs">or continue with</span>
              <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            </div>

            <div
              className={`transition-all duration-500 delay-[500ms] ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <button
                onClick={handleLogin}
                className="w-full flex items-center justify-center gap-3 bg-[#1a1a26] border border-white/5 hover:border-white/20 hover:bg-[#1f1f2a] text-white text-sm py-3 rounded-xl transition-all duration-300 group hover:scale-[1.01] active:scale-100"
              >
                <svg
                  className="w-5 h-5 transition-transform duration-300 group-hover:scale-110"
                  viewBox="0 0 24 24"
                >
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                <span className="text-white/80 group-hover:text-white transition-colors duration-300">
                  Continue with Google
                </span>
              </button>
            </div>

            <div
              className={`transition-all duration-500 delay-[550ms] ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <button
                onClick={handleLogin}
                className="w-full flex items-center justify-center gap-3 bg-[#1a1a26] border border-white/5 hover:border-white/20 hover:bg-[#1f1f2a] text-white text-sm py-3 rounded-xl transition-all duration-300 group hover:scale-[1.01] active:scale-100"
              >
                <svg
                  className="w-5 h-5 text-white/80 group-hover:text-white transition-all duration-300 group-hover:scale-110"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
                </svg>
                <span className="text-white/80 group-hover:text-white transition-colors duration-300">
                  Continue with Apple
                </span>
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
