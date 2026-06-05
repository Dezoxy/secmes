import { useState, useEffect } from 'react';
import { Eye, EyeOff, ArrowRight } from 'lucide-react';
import { startLogin } from './lib/auth';

/**
 * Landing / auth screen — ported from the downloaded "split-screen" design and adapted to Vite.
 *
 * VISUAL ONLY for now. Real auth is Zitadel OIDC: the "Sign in"/"Create account" and the
 * Google/Apple buttons will trigger an OIDC redirect (no password is posted to our server —
 * the server stays crypto-blind). The email/password fields are placeholders for the look until
 * the OIDC flow + tenant resolution land in Phase 1.
 */
export default function App() {
  const [isSignUp, setIsSignUp] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(true);
  const [currentSlide, setCurrentSlide] = useState(2);
  const [mounted, setMounted] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleModeSwitch = () => {
    setIsTransitioning(true);
    setTimeout(() => {
      setIsSignUp(!isSignUp);
      setTimeout(() => {
        setIsTransitioning(false);
      }, 50);
    }, 150);
  };

  return (
    <div className="min-h-screen bg-[#1a1a24] flex items-center justify-center p-4">
      <div
        className={`w-full max-w-4xl bg-[#12121a] rounded-3xl overflow-hidden flex flex-col lg:flex-row shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        {/* Left Panel */}
        <div className="lg:w-[45%] bg-[#0f0f16] p-5 flex flex-col">
          {/* Header */}
          <div
            className={`flex items-center justify-between mb-4 transition-all duration-500 delay-200 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
            }`}
          >
            <div className="text-white text-xl font-bold tracking-wider">
              <span className="bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
                secmes
              </span>
            </div>
            <button className="flex items-center gap-1.5 bg-[#1f1f2a]/80 backdrop-blur-sm hover:bg-[#2a2a38] text-white/90 text-xs px-3 py-1.5 rounded-full transition-all duration-300 border border-white/5 hover:border-white/10">
              Back to website
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          {/* Image Container */}
          <div
            className={`flex-1 relative rounded-2xl overflow-hidden min-h-[260px] transition-all duration-700 delay-300 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
            }`}
          >
            {/* Self-hosted gradient hero — no third-party request, fully offline (privacy fix). */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(120% 120% at 30% 15%, #3b1d6e 0%, #241043 45%, #0f0f16 100%)',
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0f0f16] via-[#0f0f16]/20 to-transparent" />

            {/* Text Overlay */}
            <div
              className={`absolute bottom-6 left-0 right-0 text-center px-4 transition-all duration-500 delay-500 ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h2 className="text-white text-xl font-semibold leading-tight tracking-tight">
                Private by design,
                <br />
                end to end
              </h2>
            </div>
          </div>

          {/* Carousel Dots */}
          <div
            className={`flex items-center justify-center gap-1.5 mt-4 transition-all duration-500 delay-[600ms] ${
              mounted ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {[0, 1, 2].map((index) => (
              <button
                key={index}
                onClick={() => setCurrentSlide(index)}
                className={`h-0.5 rounded-full transition-all duration-300 ${
                  currentSlide === index ? 'w-6 bg-white' : 'w-3 bg-white/20 hover:bg-white/40'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Right Panel - Form */}
        <div className="lg:w-[55%] p-6 lg:p-8 flex flex-col justify-center">
          <div
            className={`transition-all duration-300 ease-out ${isTransitioning ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'}`}
          >
            <h1
              className={`text-white text-2xl lg:text-3xl font-bold mb-1 tracking-tight transition-all duration-500 delay-300 ${
                mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
              }`}
            >
              {isSignUp ? 'Create an account' : 'Welcome back'}
            </h1>
            <p
              className={`text-white/40 text-sm mb-6 transition-all duration-500 delay-[350ms] ${
                mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
              }`}
            >
              {isSignUp ? 'Already have an account? ' : "Don't have an account? "}
              <button
                onClick={handleModeSwitch}
                className="text-white/80 underline underline-offset-2 hover:text-purple-400 transition-colors duration-300"
              >
                {isSignUp ? 'Log in' : 'Sign up'}
              </button>
            </p>
          </div>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void startLogin();
            }}
          >
            {/* Name Fields - Animated Height */}
            <div
              className={`grid transition-all duration-400 ease-out overflow-hidden ${
                isSignUp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                <div
                  className={`grid grid-cols-2 gap-3 pb-3 transition-all duration-500 delay-[400ms] ${
                    mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                  }`}
                >
                  <input
                    type="text"
                    placeholder="First name"
                    className="w-full bg-[#1a1a26] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all duration-300"
                  />
                  <input
                    type="text"
                    placeholder="Last name"
                    className="w-full bg-[#1a1a26] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all duration-300"
                  />
                </div>
              </div>
            </div>

            <div
              className={`transition-all duration-500 delay-[450ms] ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <input
                type="email"
                placeholder="Email"
                className="w-full bg-[#1a1a26] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all duration-300"
              />
            </div>

            <div
              className={`relative transition-all duration-500 delay-[500ms] ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                className="w-full bg-[#1a1a26] border border-white/5 rounded-xl px-4 py-2.5 pr-10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all duration-300"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors duration-300"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {/* Terms Checkbox - Animated */}
            <div
              className={`grid transition-all duration-400 ease-out overflow-hidden ${
                isSignUp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                <label
                  className={`flex items-center gap-2.5 cursor-pointer py-1 transition-all duration-500 delay-[550ms] ${
                    mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                  }`}
                >
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={agreedToTerms}
                      onChange={(e) => setAgreedToTerms(e.target.checked)}
                      className="sr-only"
                    />
                    <div
                      className={`w-4 h-4 rounded flex items-center justify-center transition-all duration-300 ${
                        agreedToTerms
                          ? 'bg-purple-500 shadow-lg shadow-purple-500/30'
                          : 'border border-white/20 bg-transparent'
                      }`}
                    >
                      <svg
                        className={`w-2.5 h-2.5 text-white transition-all duration-300 ${
                          agreedToTerms ? 'opacity-100 scale-100' : 'opacity-0 scale-50'
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={3}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </div>
                  </div>
                  <span className="text-white/40 text-xs">
                    I agree to the{' '}
                    <a
                      href="#"
                      className="text-purple-400 underline underline-offset-2 hover:text-purple-300 transition-colors duration-300"
                    >
                      Terms &amp; Conditions
                    </a>
                  </span>
                </label>
              </div>
            </div>

            <div
              className={`transition-all duration-500 delay-[600ms] ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <button
                type="submit"
                className="w-full bg-purple-500 hover:bg-purple-400 text-white font-medium py-2.5 rounded-xl transition-all duration-300 text-sm shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:-translate-y-0.5 active:translate-y-0 active:shadow-purple-500/20"
              >
                <span
                  className={`inline-block transition-all duration-300 ${isTransitioning ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}
                >
                  {isSignUp ? 'Create account' : 'Sign in'}
                </span>
              </button>
            </div>
          </form>

          {/* Divider */}
          <div
            className={`flex items-center gap-3 my-5 transition-all duration-500 delay-[650ms] ${
              mounted ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <span
              className={`text-white/30 text-xs transition-all duration-300 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}
            >
              {isSignUp ? 'Or register with' : 'Or sign in with'}
            </span>
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>

          {/* Social Buttons (will become OIDC providers via Zitadel) */}
          <div
            className={`grid grid-cols-2 gap-3 transition-all duration-500 delay-700 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}
          >
            <button
              onClick={() => void startLogin()}
              className="flex items-center justify-center gap-2 bg-[#1a1a26] border border-white/5 hover:border-white/20 hover:bg-[#1f1f2a] text-white text-sm py-2.5 rounded-xl transition-all duration-300 group hover:scale-[1.02] active:scale-100"
            >
              <svg
                className="w-4 h-4 transition-transform duration-300 group-hover:scale-110"
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
                Google
              </span>
            </button>
            <button
              onClick={() => void startLogin()}
              className="flex items-center justify-center gap-2 bg-[#1a1a26] border border-white/5 hover:border-white/20 hover:bg-[#1f1f2a] text-white text-sm py-2.5 rounded-xl transition-all duration-300 group hover:scale-[1.02] active:scale-100"
            >
              <svg
                className="w-4 h-4 text-white/80 group-hover:text-white transition-all duration-300 group-hover:scale-110"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
              </svg>
              <span className="text-white/80 group-hover:text-white transition-colors duration-300">
                Apple
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
