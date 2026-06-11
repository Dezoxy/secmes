import { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, Image as ImageIcon, Plus, Smile, X } from 'lucide-react';
import {
  EmptyState,
  IconButton,
  floatingMenuItemClass,
  floatingMenuMotion,
  floatingMenuSurfaceClass,
} from '../ui';

interface ChatInputProps {
  onSend: (content: string, attachments?: File[]) => void;
  /** Disable the composer (e.g. a live conversation whose send path lands in a later slice). */
  disabled?: boolean;
  /** Shown in place of the composer when `disabled`. */
  disabledNotice?: string;
}

const COMPOSER_CONTROL =
  'h-11 min-h-11 rounded-xl border border-white/5 transition-all duration-300';

export function ChatInput({ onSend, disabled = false, disabledNotice }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!actionMenuOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setActionMenuOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [actionMenuOpen]);

  const handleSend = () => {
    if (message.trim() || attachments.length > 0) {
      onSend(message.trim(), attachments);
      setMessage('');
      setAttachments([]);
      setPreviews([]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setAttachments((prev) => [...prev, ...files]);
      // Composer previews are local data URIs (FileReader) — never object URLs / server URLs.
      files.forEach((file) => {
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onloadend = () => setPreviews((prev) => [...prev, reader.result as string]);
          reader.readAsDataURL(file);
        } else {
          setPreviews((prev) => [...prev, '']);
        }
      });
    }
    e.target.value = '';
  };

  const openFilePicker = () => {
    setActionMenuOpen(false);
    fileInputRef.current?.click();
  };

  const openImagePicker = () => {
    setActionMenuOpen(false);
    imageInputRef.current?.click();
  };

  const insertEmoji = () => {
    setMessage((prev) => `${prev}🙂`);
    setActionMenuOpen(false);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  };

  if (disabled) {
    return (
      <div className="border-t border-white/5 bg-[#0f0f16] p-4">
        <EmptyState title="Messaging unavailable" compact>
          {disabledNotice ?? 'Messaging is not available here yet.'}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="border-t border-white/5 bg-[#0f0f16] p-3">
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex gap-2 mb-3 overflow-x-auto pb-2"
        >
          {attachments.map((file, index) => (
            <div key={index} className="relative shrink-0 group">
              {file.type.startsWith('image/') && previews[index] ? (
                <div className="w-20 h-20 rounded-lg overflow-hidden bg-[#1a1a26]">
                  <img
                    src={previews[index]}
                    alt={file.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div className="w-20 h-20 rounded-lg bg-[#1a1a26] flex flex-col items-center justify-center p-2">
                  <Paperclip aria-hidden="true" className="w-5 h-5 text-white/60 mb-1" />
                  <span className="text-xs text-white/60 truncate w-full text-center">
                    {file.name.split('.').pop()?.toUpperCase()}
                  </span>
                </div>
              )}
              <IconButton
                onClick={() => removeAttachment(index)}
                variant="danger"
                size="xs"
                className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-red-500 text-white opacity-0 transition-opacity duration-200 hover:bg-red-500/90 group-hover:opacity-100"
                aria-label={`Remove ${file.name}`}
              >
                <X className="w-3 h-3 text-white" />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <div ref={actionsRef} className="relative shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
            multiple
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
            multiple
          />
          <IconButton
            onClick={() => setActionMenuOpen((open) => !open)}
            className={`${COMPOSER_CONTROL} flex w-11 items-center justify-center bg-[#1a1a26] text-white/45 hover:border-purple-500/30 hover:text-white/80`}
            aria-label="Open message actions"
            aria-expanded={actionMenuOpen}
            aria-haspopup="menu"
          >
            <Plus
              className={`h-5 w-5 transition-transform duration-300 ${
                actionMenuOpen ? 'rotate-45' : ''
              }`}
            />
          </IconButton>

          <div
            className={`absolute bottom-full left-0 z-20 mb-3 w-48 origin-bottom-left ${floatingMenuSurfaceClass} ${floatingMenuMotion(
              actionMenuOpen,
              'bottom',
            )}`}
            role="menu"
            aria-label="Message actions"
            aria-hidden={!actionMenuOpen}
          >
            <button
              type="button"
              onClick={openFilePicker}
              tabIndex={actionMenuOpen ? 0 : -1}
              className={`${floatingMenuItemClass} text-white/65 hover:bg-white/[0.05] hover:text-white`}
              role="menuitem"
            >
              <Paperclip className="h-4 w-4" />
              Attach file
            </button>
            <button
              type="button"
              onClick={openImagePicker}
              tabIndex={actionMenuOpen ? 0 : -1}
              className={`${floatingMenuItemClass} text-white/65 hover:bg-white/[0.05] hover:text-white`}
              role="menuitem"
            >
              <ImageIcon className="h-4 w-4" />
              Add image
            </button>
            <button
              type="button"
              onClick={insertEmoji}
              tabIndex={actionMenuOpen ? 0 : -1}
              className={`${floatingMenuItemClass} text-white/65 hover:bg-white/[0.05] hover:text-white`}
              role="menuitem"
            >
              <Smile className="h-4 w-4" />
              Insert emoji
            </button>
          </div>
        </div>

        <div className="flex-1 relative">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Message"
            placeholder="Type a message..."
            rows={1}
            className={`${COMPOSER_CONTROL} block w-full resize-none overflow-hidden bg-[#1a1a26] px-3.5 py-2.5 text-sm leading-5 text-white placeholder-white/30 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20`}
          />
        </div>

        <IconButton
          onClick={handleSend}
          disabled={!message.trim() && attachments.length === 0}
          className={`${COMPOSER_CONTROL} flex w-11 shrink-0 items-center justify-center bg-purple-500 shadow-lg shadow-purple-500/25 hover:-translate-y-0.5 hover:bg-purple-400 hover:shadow-purple-500/40 active:translate-y-0 disabled:cursor-not-allowed disabled:bg-purple-500/50 disabled:shadow-none disabled:translate-y-0`}
          aria-label="Send message"
        >
          <Send className="w-5 h-5 text-white" />
        </IconButton>
      </div>
    </div>
  );
}
