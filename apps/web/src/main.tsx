import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './features/auth/AuthContext';
import { PwaUpdateProvider } from './features/pwa/PwaUpdateProvider';
import { ToastProvider, applyThemeToDocument } from './features/ui';
import { readStoredDeviceSettings } from './features/settings/device-settings';
import './index.css';

// Only an installed PWA pins maximum-scale=1 — this stops iOS from zooming the page when a small
// input is focused. We do it here (not in the static viewport meta) so a normal browser tab keeps
// pinch-zoom available for accessibility. iOS exposes installed PWAs via the non-standard
// navigator.standalone; other engines via the display-mode media query.
const isInstalledPwa =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
if (isInstalledPwa) {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      'content',
      'width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1',
    );
}

// Apply stored appearance settings before first paint to avoid FOUC.
const { accentId, fontSizeLevel } = readStoredDeviceSettings();
applyThemeToDocument(accentId, fontSizeLevel);

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
