import { AlertCircle, Check, CheckCheck, FileText, Download, Lock } from 'lucide-react';
import { saveAttachment } from '../../lib/attachments';
import { AttachmentImage } from './AttachmentImage';
import type { Message, User, MessageStatus } from './seed';
import { formatFullTime } from './seed';
import { Avatar, IconButton, sentMessageEnterMotion } from '../ui';

function StatusIcon({ status }: { status: MessageStatus }) {
  switch (status) {
    case 'sending':
      return <Check className="w-3.5 h-3.5 text-white/30" />;
    case 'sent':
      return <Check className="w-3.5 h-3.5 text-white/40" />;
    case 'delivered':
      return <CheckCheck className="w-3.5 h-3.5 text-white/40" />;
    case 'read':
      return <CheckCheck className="w-3.5 h-3.5 text-purple-400" />;
    case 'failed':
      return <AlertCircle className="w-3.5 h-3.5 text-red-400" aria-label="Not sent" />;
  }
}

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  sender?: User;
  showSender?: boolean;
  animateIn?: boolean;
  onImageClick?: (url: string) => void;
}

export function MessageBubble({
  message,
  isOwn,
  sender,
  showSender,
  animateIn = false,
  onImageClick,
}: MessageBubbleProps) {
  const hasAttachments = message.attachments && message.attachments.length > 0;

  return (
    <div
      className={`flex ${isOwn ? 'justify-end' : 'justify-start'} group ${
        animateIn ? sentMessageEnterMotion : ''
      }`}
    >
      <div className={`flex gap-2 max-w-[75%] ${isOwn ? 'flex-row-reverse' : ''}`}>
        {/* Avatar for received messages in a group */}
        {!isOwn && showSender && sender && (
          <div className="shrink-0 mt-auto">
            <Avatar
              src={sender.avatar}
              name={sender.name}
              size="sm"
              shape="circle"
              className="ring-2 ring-white/5"
            />
          </div>
        )}

        <div className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
          {!isOwn && showSender && sender && (
            <span className="text-xs text-purple-400 mb-1 ml-1">{sender.name}</span>
          )}

          <div
            className={`rounded-2xl px-4 py-2.5 transition-all duration-300 ${
              isOwn
                ? 'bg-purple-500 text-white rounded-br-md'
                : 'bg-[#1a1a26] text-white/90 rounded-bl-md border border-white/5'
            }`}
          >
            {hasAttachments && (
              <div className="mb-2 space-y-2">
                {message.attachments!.map((attachment) =>
                  attachment.type === 'image' ? (
                    attachment.ref && !attachment.url ? (
                      // Received E2E image — download + decrypt + render lazily on view.
                      <AttachmentImage
                        key={attachment.id}
                        refData={attachment.ref}
                        onClick={onImageClick}
                      />
                    ) : attachment.url ? (
                      // Seed image, or own-send echo (local data URI).
                      <button
                        key={attachment.id}
                        type="button"
                        onClick={() => onImageClick?.(attachment.url!)}
                        className="block relative rounded-lg overflow-hidden cursor-pointer group/img"
                      >
                        <img
                          src={attachment.url}
                          alt={attachment.name}
                          className="max-w-[260px] max-h-64 w-full object-cover rounded-lg transition-transform duration-300 group-hover/img:scale-105"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors duration-300" />
                      </button>
                    ) : null
                  ) : (
                    <div
                      key={attachment.id}
                      className={`flex items-center gap-3 p-3 rounded-lg ${
                        isOwn ? 'bg-purple-600/50' : 'bg-[#12121a]'
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          isOwn ? 'bg-purple-700' : 'bg-purple-500/20'
                        }`}
                      >
                        <FileText
                          className={`w-5 h-5 ${isOwn ? 'text-white' : 'text-purple-400'}`}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-sm font-medium truncate ${
                            isOwn ? 'text-white' : 'text-white/90'
                          }`}
                        >
                          {attachment.name}
                        </p>
                        {attachment.size && (
                          <p className={`text-xs ${isOwn ? 'text-white/60' : 'text-white/40'}`}>
                            {attachment.size}
                          </p>
                        )}
                      </div>
                      <IconButton
                        onClick={() => attachment.ref && void saveAttachment(attachment.ref)}
                        disabled={!attachment.ref}
                        aria-label={`Download ${attachment.name}`}
                        className={`rounded-lg ${
                          isOwn
                            ? 'hover:bg-purple-700 text-white/80 hover:text-white'
                            : 'hover:bg-white/5 text-white/40 hover:text-white/60'
                        }`}
                      >
                        <Download className="w-4 h-4" />
                      </IconButton>
                    </div>
                  ),
                )}
              </div>
            )}

            {message.content && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
            )}
          </div>

          {/* Timestamp + status */}
          <div
            className={`flex items-center gap-1.5 mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${
              isOwn ? 'flex-row-reverse' : ''
            }`}
          >
            <span className="text-xs text-white/30">{formatFullTime(message.timestamp)}</span>
            {isOwn && message.encrypted && (
              <span title="Ran a real MLS encrypt→decrypt in this browser (demo — not yet to a remote recipient)">
                <Lock
                  className="w-3 h-3 text-purple-400/70"
                  aria-label="Encrypted via MLS (demo)"
                />
              </span>
            )}
            {isOwn && <StatusIcon status={message.status} />}
          </div>
        </div>
      </div>
    </div>
  );
}
