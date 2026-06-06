import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import Callback from './routes/Callback';
import ChatScreen from './features/chat/ChatScreen';
import { AuthProvider, RequireAuth } from './features/auth/AuthContext';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<App />} />
          <Route
            path="/chat"
            element={
              <RequireAuth>
                <ChatScreen />
              </RequireAuth>
            }
          />
          <Route path="/auth/callback" element={<Callback />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
