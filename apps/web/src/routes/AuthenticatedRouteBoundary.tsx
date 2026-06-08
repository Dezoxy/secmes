import type { ReactNode } from 'react';
import { RequireAuth } from '../features/auth/AuthContext';

export function AuthenticatedRouteBoundary({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
