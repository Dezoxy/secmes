import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './features/auth/AuthContext';
import { PwaUpdateProvider } from './features/pwa/PwaUpdateProvider';
import { ToastProvider } from './features/ui';
import './index.css';

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
