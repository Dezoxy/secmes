import { AlertCircle, Check, CheckCheck, Image as ImageIcon, Lock } from 'lucide-react';
import type { ChatMessage, Contact, DeliveryStatus } from './types';
import { ME } from './types';
import { formatClockTime } from './format';

function StatusTicks({ status }: { status: DeliveryStatus }) {
  if (status === 'sending') return <Check className="h-3.5 w-3.5 text-white/30" />;
  if (status === 'sent') return <Check className="h-3.5 w-3.5 text-white/40" />;
  if (status === 'delivered') return <CheckCheck className="h-3.5 w-3.5 text-white/40" />;
  if (status === 'failed')
    return <AlertCircle className="h-3.5 w-3.5 text-red-400" aria-label="Not sent" />;
  return <CheckCheck className="h-3.5 w-3.5 text-purple-400" />; // read
}

interface MessageBubbleProps {
  message: ChatMessage;
  sender?: Contact;
  showSender?: boolean;
  onImageClick?: (src: string) => void;
}

export function MessageBubble({
  message,
  sender,
  showSender = false,
  onImageClick,
}: MessageBubbleProps) {
  const isOwn = message.senderId === ME;
  const images = message.images ?? [];
  return (
    <div className={`group flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[75%] flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && showSender && sender && (
          <span className="mb-1 ml-1 text-xs text-purple-400">{sender.name}</span>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 ${
            isOwn
              ? 'rounded-br-md bg-purple-500 text-white'
              : 'rounded-bl-md border border-white/5 bg-[#1a1a26] text-white/90'
          }`}
        >
          {images.length > 0 && (
            <div className="mb-2 space-y-2">
              {images.map((img) => {
                const src = img.src;
                return src ? (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => onImageClick?.(src)}
                    className="block overflow-hidden rounded-lg"
                  >
                    <img
                      src={src}
                      alt={img.name}
                      className="h-auto max-h-64 w-full max-w-[260px] rounded-lg object-cover transition-transform duration-300 hover:scale-[1.03]"
                    />
                  </button>
                ) : (
                  <div
                    key={img.id}
                    className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2 text-sm"
                  >
                    <ImageIcon className="h-4 w-4 shrink-0 text-purple-300" />
                    <span className="truncate">{img.name}</span>
                  </div>
                );
              })}
            </div>
          )}
          {message.body && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.body}</p>
          )}
        </div>
        <div
          className={`mt-1 flex items-center gap-1.5 px-1 opacity-0 transition-opacity duration-300 group-hover:opacity-100 ${
            isOwn ? 'flex-row-reverse' : ''
          }`}
        >
          <span className="text-xs text-white/30">{formatClockTime(message.sentAt)}</span>
          {isOwn && message.encrypted && (
            <span title="Ran a real MLS encrypt→decrypt in this browser (demo — not yet to a remote recipient)">
              <Lock className="h-3 w-3 text-purple-400/70" aria-label="Encrypted via MLS (demo)" />
            </span>
          )}
          {isOwn && <StatusTicks status={message.status} />}
        </div>
      </div>
    </div>
  );
}
