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

export const modalBackdropEnterMotion = 'argus-overlay-enter';
export const modalPanelEnterMotion = 'argus-modal-enter';
export const conversationEnterMotion = 'argus-pane-enter';
export const sentMessageEnterMotion = 'argus-message-send-enter';
export const surfaceEnterMotion = 'argus-surface-enter';
