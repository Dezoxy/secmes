type FloatingMenuOrigin = 'top' | 'bottom';

const hiddenTranslate: Record<FloatingMenuOrigin, string> = {
  top: '-translate-y-2',
  bottom: 'translate-y-2',
};

export function floatingMenuMotion(open: boolean, origin: FloatingMenuOrigin): string {
  return `transition-all duration-200 ease-out motion-reduce:transition-none ${
    open
      ? 'translate-y-0 scale-100 opacity-100'
      : `pointer-events-none ${hiddenTranslate[origin]} scale-95 opacity-0`
  }`;
}

export const floatingMenuSurfaceClass =
  'rounded-xl border border-white/10 bg-[#151520]/95 p-2 shadow-2xl shadow-black/50 backdrop-blur-xl';
export const floatingMenuItemClass =
  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors';

export const modalBackdropEnterMotion = 'argus-overlay-enter';
export const modalBackdropExitMotion = 'argus-overlay-exit';
export const modalPanelEnterMotion = 'argus-modal-enter';
export const modalPanelExitMotion = 'argus-modal-exit';
export const conversationEnterMotion = 'argus-pane-enter';
export const paneBackEnterMotion = 'argus-pane-back-enter';
export const paneBackExitMotion = 'argus-pane-back-exit';
export const sentMessageEnterMotion = 'argus-message-send-enter';
export const surfaceEnterMotion = 'argus-surface-enter';
