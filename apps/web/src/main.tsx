import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './features/auth/AuthContext';
import { PwaUpdateProvider } from './features/pwa/PwaUpdateProvider';
import { ToastProvider } from './features/ui';
import './index.css';

// Only an installed (standalone) PWA pins maximum-scale=1 — this stops iOS from zooming the page
// when a small input is focused. We do it here (not in the static viewport meta) so a normal
// browser tab keeps pinch-zoom available for accessibility. iOS exposes standalone via the
// non-standard navigator.standalone; other engines via the display-mode media query.
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
if (isStandalone) {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      'content',
      'width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1',
    );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PwaUpdateProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </PwaUpdateProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
