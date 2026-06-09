import { createContext, useContext, type ReactNode } from 'react';

export type PwaUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'unsupported'
  | 'error';

export interface PwaUpdateContextValue {
  canCheckForUpdate: boolean;
  updateReady: boolean;
  showUpdatePrompt: boolean;
  status: PwaUpdateStatus;
  lastCheckedAt: Date | null;
  checkForUpdate: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  dismissUpdate: () => void;
}

export const defaultPwaUpdateContext: PwaUpdateContextValue = {
  canCheckForUpdate: false,
  updateReady: false,
  showUpdatePrompt: false,
  status: 'unsupported',
  lastCheckedAt: null,
  checkForUpdate: async () => undefined,
  applyUpdate: async () => undefined,
  dismissUpdate: () => undefined,
};

const PwaUpdateContext = createContext<PwaUpdateContextValue>(defaultPwaUpdateContext);

interface PwaUpdateContextProviderProps {
  children: ReactNode;
  value: PwaUpdateContextValue;
}

export function PwaUpdateContextProvider({ children, value }: PwaUpdateContextProviderProps) {
  return <PwaUpdateContext.Provider value={value}>{children}</PwaUpdateContext.Provider>;
}

export function usePwaUpdate(): PwaUpdateContextValue {
  return useContext(PwaUpdateContext);
}
