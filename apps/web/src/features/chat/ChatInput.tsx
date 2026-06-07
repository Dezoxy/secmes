import { useState, useRef } from 'react';
import { Send, Paperclip, Image as ImageIcon, Smile, X } from 'lucide-react';

interface ChatInputProps {
  onSend: (content: string, attachments?: File[]) => void;
  /** Disable the composer (e.g. a live conversation whose send path lands in a later slice). */
  disabled?: boolean;
  /** Shown in place of the composer when `disabled`. */
  disabledNotice?: string;
}

export function ChatInput({ onSend, disabled = false, disabledNotice }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

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

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  };

  if (disabled) {
    return (
      <div className="border-t border-white/5 bg-[#0f0f16] p-4">
        <p className="text-center text-xs leading-relaxed text-white/40">
          {disabledNotice ?? 'Messaging is not available here yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-white/5 bg-[#0f0f16] p-4">
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-3 overflow-x-auto pb-2">
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
                  <Paperclip className="w-5 h-5 text-white/40 mb-1" />
                  <span className="text-xs text-white/40 truncate w-full text-center">
                    {file.name.split('.').pop()?.toUpperCase()}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(index)}
                className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div className="flex gap-1 shrink-0">
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
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 rounded-xl text-white/40 hover:text-white/70 hover:bg-[#1a1a26] transition-all duration-300"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            className="p-2.5 rounded-xl text-white/40 hover:text-white/70 hover:bg-[#1a1a26] transition-all duration-300"
          >
            <ImageIcon className="w-5 h-5" />
          </button>
          <button
            type="button"
            className="p-2.5 rounded-xl text-white/40 hover:text-white/70 hover:bg-[#1a1a26] transition-all duration-300"
          >
            <Smile className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 relative">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="w-full bg-[#1a1a26] border border-white/5 rounded-xl px-4 py-3 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all duration-300 resize-none max-h-32"
            style={{ minHeight: '46px' }}
          />
        </div>

        <button
          type="button"
          onClick={handleSend}
          disabled={!message.trim() && attachments.length === 0}
          className="p-3 bg-purple-500 hover:bg-purple-400 disabled:bg-purple-500/50 disabled:cursor-not-allowed rounded-xl transition-all duration-300 shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:-translate-y-0.5 active:translate-y-0 disabled:shadow-none disabled:translate-y-0"
        >
          <Send className="w-5 h-5 text-white" />
        </button>
      </div>
    </div>
  );
}
