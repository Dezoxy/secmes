import type { ReactNode } from 'react';
import { RequireAuth } from '../features/auth/AuthContext';
import { OnboardingGate } from '../features/onboarding/OnboardingGate';

export function AuthenticatedRouteBoundary({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <OnboardingGate>{children}</OnboardingGate>
    </RequireAuth>
  );
}
