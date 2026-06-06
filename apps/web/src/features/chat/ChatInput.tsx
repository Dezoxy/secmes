import { type ChangeEvent, type KeyboardEvent, useRef, useState } from 'react';
import { Image as ImageIcon, Paperclip, Send, Smile, X } from 'lucide-react';

interface ChatInputProps {
  onSend: (body: string, images: File[]) => void;
}

export function ChatInput({ onSend }: ChatInputProps) {
  const [body, setBody] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const send = () => {
    if (!body.trim() && images.length === 0) return;
    onSend(body.trim(), images);
    setBody('');
    setImages([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    setImages((prev) => [...prev, ...picked]);
    e.target.value = '';
  };

  const remove = (i: number) => setImages((prev) => prev.filter((_, idx) => idx !== i));

  const canSend = body.trim().length > 0 || images.length > 0;

  return (
    <div className="border-t border-white/5 bg-[#0f0f16] p-4">
      {/* Pending-attachment chips. We deliberately do NOT render a thumbnail from the raw file here —
          rich, decrypted thumbnails belong to the encrypted-image pipeline (attachments table + content
          key), not a local object-URL preview. Chips keep the composer simple and the bundle XSS-clean. */}
      {images.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {images.map((file, i) => (
            <div
              key={`${file.name}-${file.size}-${i}`}
              className="flex items-center gap-2 rounded-lg border border-white/5 bg-[#1a1a26] py-1.5 pl-2.5 pr-1.5 text-sm text-white/80"
            >
              <ImageIcon className="h-4 w-4 shrink-0 text-purple-400" />
              <span className="max-w-[160px] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="rounded-md p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-white/70"
                aria-label={`Remove ${file.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-3">
        <div className="flex shrink-0 gap-1">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPick}
          />
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            className="rounded-xl p-2.5 text-white/40 transition-colors hover:bg-[#1a1a26] hover:text-white/70"
            aria-label="Attach image"
          >
            <ImageIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="rounded-xl p-2.5 text-white/40 transition-colors hover:bg-[#1a1a26] hover:text-white/70"
            aria-label="Attach file"
          >
            <Paperclip className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="rounded-xl p-2.5 text-white/40 transition-colors hover:bg-[#1a1a26] hover:text-white/70"
            aria-label="Emoji"
          >
            <Smile className="h-5 w-5" />
          </button>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message..."
          rows={1}
          className="max-h-32 min-h-[46px] flex-1 resize-none rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-3 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
        />
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          className="rounded-xl bg-purple-500 p-3 text-white shadow-lg shadow-purple-500/25 transition-all hover:-translate-y-0.5 hover:bg-purple-400 hover:shadow-purple-500/40 active:translate-y-0 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-purple-500/50 disabled:shadow-none"
          aria-label="Send message"
        >
          <Send className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
