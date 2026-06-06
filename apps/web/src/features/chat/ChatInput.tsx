import { type ChangeEvent, type KeyboardEvent, useRef, useState } from 'react';
import { Image as ImageIcon, Paperclip, Send, Smile, X } from 'lucide-react';

interface ChatInputProps {
  onSend: (body: string, images: File[]) => void;
}

export function ChatInput({ onSend }: ChatInputProps) {
  const [body, setBody] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    previews.forEach((p) => URL.revokeObjectURL(p));
    setBody('');
    setImages([]);
    setPreviews([]);
  };

  const send = () => {
    if (!body.trim() && images.length === 0) return;
    onSend(body.trim(), images);
    reset();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    setImages((prev) => [...prev, ...files]);
    setPreviews((prev) => [...prev, ...files.map((f) => URL.createObjectURL(f))]);
    e.target.value = '';
  };

  const remove = (i: number) => {
    URL.revokeObjectURL(previews[i] ?? '');
    setImages((prev) => prev.filter((_, idx) => idx !== i));
    setPreviews((prev) => prev.filter((_, idx) => idx !== i));
  };

  const canSend = body.trim().length > 0 || images.length > 0;

  return (
    <div className="border-t border-white/5 bg-[#0f0f16] p-4">
      {previews.length > 0 && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-2">
          {previews.map((src, i) => (
            <div key={src} className="group relative shrink-0">
              <img
                src={src}
                alt="Attachment preview"
                className="h-20 w-20 rounded-lg object-cover"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Remove image"
              >
                <X className="h-3 w-3 text-white" />
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
