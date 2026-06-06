import { useState, useEffect } from 'react';
import { MessageCircle } from 'lucide-react';
import { getMlsSession } from '../../lib/mls';
import { RecoveryPanel } from '../recovery/RecoveryPanel';
import { ConversationList } from './ConversationList';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ImagePreviewModal } from './ImagePreviewModal';
import { VerifySecurity } from './VerifySecurity';
import type { Attachment, Conversation, Message } from './seed';
import {
  conversations as initialConversations,
  currentUser,
  getConversationDisplayName,
} from './seed';

/**
 * Chat experience, ported from the reworked design (`~/Downloads`) into the Vite PWA.
 *
 * Conversations come from a local seed, but SENDING runs a real in-browser MLS (RFC 9420) encrypt→
 * decrypt round-trip via @argus/crypto (lib/mls.ts) — proving the E2EE path (a lock appears once a
 * message is through it; a failed round-trip marks it failed, never sent). The live loop swaps the
 * local peer for a remote member over the WS gateway and back-fills history by decrypting fetched
 * ciphertext; it needs the key directory + out-of-band fingerprint verification (#20). No plaintext
 * leaves the browser. The settings button opens key-recovery (back up / restore the device identity).
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

// Local data-URI attachment (never an object URL or server URL). Images render inline; other files
// become a chip. Attachments are demo-local — only the text body goes through the MLS round-trip.
async function toAttachment(file: File): Promise<Attachment> {
  const id = `att-${crypto.randomUUID()}`;
  const size = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  if (file.type.startsWith('image/')) {
    return { id, type: 'image', url: await fileToDataUrl(file), name: file.name, size };
  }
  return { id, type: 'file', url: '#', name: file.name, size };
}

export default function ChatScreen() {
  const [mounted, setMounted] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [selectedId, setSelectedId] = useState<string | null>('conv-1');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [sessionNumber, setSessionNumber] = useState<string | null>(null);
  const [verifiedNumber, setVerifiedNumber] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The 2-party session's out-of-band safety number (#20) — computed once; stable per page load.
  useEffect(() => {
    void getMlsSession()
      .then((s) => setSessionNumber(s.safetyNumber))
      .catch(() => setSessionNumber(null));
  }, []);

  // Verified only while the marked number still matches the current key (resets if the key changes).
  const verified = sessionNumber !== null && verifiedNumber === sessionNumber;

  const selectedConversation = conversations.find((c) => c.id === selectedId);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) setShowSidebar(false);
  };

  const patchMessage = (convId: string, msgId: string, patch: Partial<Message>): void => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? { ...c, messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)) }
          : c,
      ),
    );
  };

  const handleSend = (content: string, files?: File[]): void => {
    if (!selectedId) return;
    const convId = selectedId;
    const id = `msg-${crypto.randomUUID()}`; // CSPRNG id; the real client_message_id is minted the same way
    void (async () => {
      const attachments = files?.length ? await Promise.all(files.map(toAttachment)) : undefined;
      const message: Message = {
        id,
        senderId: currentUser.id,
        content,
        timestamp: new Date(),
        status: 'sending',
        attachments,
      };
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, message] } : c)),
      );
      // Run a REAL MLS encrypt→decrypt round-trip before marking the message sent — the recovered
      // plaintext confirms the E2EE path and a lock shows. A failure marks the bubble failed, never
      // sent (no false delivery signal); `encrypted` stays false so no lock shows.
      try {
        const session = await getMlsSession();
        await session.send(content || '(attachment)');
        patchMessage(convId, id, { status: 'sent', encrypted: true });
        setTimeout(() => patchMessage(convId, id, { status: 'delivered' }), 1000);
        setTimeout(() => patchMessage(convId, id, { status: 'read' }), 2500);
      } catch {
        patchMessage(convId, id, { status: 'failed' });
      }
    })();
  };

  return (
    <div className="min-h-screen bg-[#1a1a24] flex items-center justify-center p-4">
      <div
        className={`w-full max-w-6xl h-[90vh] bg-[#12121a] rounded-3xl overflow-hidden flex shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        {/* Sidebar */}
        <div
          className={`${
            showSidebar ? 'flex' : 'hidden lg:flex'
          } w-full lg:w-80 shrink-0 flex-col bg-[#0f0f16] border-r border-white/5 transition-all duration-500 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8'
          }`}
        >
          <div className="p-4 border-b border-white/5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-purple-500 rounded-lg flex items-center justify-center">
                <MessageCircle className="w-4 h-4 text-white" />
              </div>
              <span className="text-xl font-bold tracking-wider">
                <span className="bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
                  ARGUS
                </span>
              </span>
            </div>
          </div>

          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={handleSelect}
            onSettings={() => setRecoveryOpen(true)}
          />
        </div>

        {/* Main */}
        <div
          className={`${
            !showSidebar ? 'flex' : 'hidden lg:flex'
          } flex-1 flex-col transition-all duration-500 delay-100 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
          }`}
        >
          {selectedConversation ? (
            <>
              <ChatHeader
                conversation={selectedConversation}
                onBack={() => setShowSidebar(true)}
                verified={verified}
                onVerify={() => setVerifyOpen(true)}
              />
              <MessageList conversation={selectedConversation} onImageClick={setPreviewImage} />
              <ChatInput onSend={handleSend} />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <div className="w-20 h-20 bg-purple-500/20 rounded-full flex items-center justify-center mb-4">
                <MessageCircle className="w-10 h-10 text-purple-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Welcome to Argus</h2>
              <p className="text-white/40 max-w-sm">
                Select a conversation from the sidebar to start messaging
              </p>
            </div>
          )}
        </div>
      </div>

      <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />
      {recoveryOpen && <RecoveryPanel onClose={() => setRecoveryOpen(false)} />}
      {verifyOpen && (
        <VerifySecurity
          peerName={
            selectedConversation
              ? getConversationDisplayName(selectedConversation, currentUser.id)
              : 'this contact'
          }
          safetyNumber={sessionNumber}
          verified={verified}
          onVerifiedChange={(v) => setVerifiedNumber(v ? sessionNumber : null)}
          onClose={() => setVerifyOpen(false)}
        />
      )}
    </div>
  );
}
