import { createContext, useContext } from 'react';

export const NavVisibilityContext = createContext<(visible: boolean) => void>(() => {});
export const useSetNavVisible = () => useContext(NavVisibilityContext);
