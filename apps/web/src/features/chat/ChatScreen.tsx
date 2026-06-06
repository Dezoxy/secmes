import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { ChatMessage, Conversation } from './types';
import { ME } from './types';
import { getMlsSession } from '../../lib/mls';
import { seedConversations } from './seed';
import { ConversationList } from './ConversationList';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ImagePreviewModal } from './ImagePreviewModal';
import { RecoveryPanel } from '../recovery/RecoveryPanel';

/**
 * Chat experience, rebuilt in the Vite PWA from the design (Phase-5 #41).
 *
 * Conversations come from a local seed, but SENDING runs a real in-browser MLS (RFC 9420) encrypt→
 * decrypt round-trip via @argus/crypto (see lib/mls.ts) — proving the E2EE path end-to-end (a lock
 * appears once a message has been through it). The live loop swaps the local peer for a remote member
 * over the WS gateway and back-fills history by decrypting fetched ciphertext; it needs auth (Zitadel) +
 * the key directory + fingerprint verification, none of which exist yet. No plaintext leaves the browser.
 */
export default function ChatScreen() {
  const [conversations, setConversations] = useState<Conversation[]>(seedConversations);
  const [selectedId, setSelectedId] = useState<string | null>(seedConversations[0]?.id ?? null);
  const [preview, setPreview] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  const selected = conversations.find((c) => c.id === selectedId);

  const select = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) setShowSidebar(false);
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  };

  const patchMessage = (convId: string, msgId: string, patch: Partial<ChatMessage>): void => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? { ...c, messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)) }
          : c,
      ),
    );
  };

  const send = (body: string, images: File[]) => {
    if (!selectedId) return;
    const convId = selectedId;
    const id = crypto.randomUUID(); // CSPRNG id; the real client_message_id is minted the same way
    const message: ChatMessage = {
      id,
      senderId: ME,
      body,
      sentAt: Date.now(),
      status: 'sending',
      // Shell: carry the file name only — rendering a decrypted thumbnail is the encrypted-image slice.
      images: images.map((f, i) => ({ id: `${id}-${i}`, name: f.name })),
    };
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, message] } : c)),
    );
    // Run a REAL MLS encrypt→decrypt round-trip (in-browser, via @argus/crypto) before marking the
    // message sent — the recovered plaintext confirms the E2EE path, and a lock shows on the bubble.
    // The live loop swaps the local peer for a remote member over the WS gateway (needs auth + the key
    // directory + out-of-band fingerprint verification); the simulated delivery timing stands in for it.
    void getMlsSession()
      .then((session) => session.send(body || '(attachment)'))
      .then(() => {
        patchMessage(convId, id, { status: 'sent', encrypted: true });
        setTimeout(() => patchMessage(convId, id, { status: 'delivered' }), 800);
        setTimeout(() => patchMessage(convId, id, { status: 'read' }), 1800);
      })
      .catch(() => patchMessage(convId, id, { status: 'sent' }));
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[#1a1a24] sm:p-4">
      <div className="flex h-full w-full max-w-6xl overflow-hidden bg-[#12121a] shadow-2xl shadow-black/50 sm:h-[90vh] sm:rounded-3xl">
        {/* Sidebar */}
        <div
          className={`${showSidebar ? 'flex' : 'hidden lg:flex'} w-full shrink-0 flex-col border-r border-white/5 bg-[#0f0f16] lg:w-80`}
        >
          <div className="border-b border-white/5 p-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500">
                <MessageCircle className="h-4 w-4 text-white" />
              </div>
              <span className="bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-xl font-bold tracking-wider text-transparent">
                ARGUS
              </span>
            </div>
          </div>
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={select}
            onSettings={() => setRecoveryOpen(true)}
          />
        </div>

        {/* Main */}
        <div className={`${showSidebar ? 'hidden lg:flex' : 'flex'} flex-1 flex-col`}>
          {selected ? (
            <>
              <ChatHeader conversation={selected} onBack={() => setShowSidebar(true)} />
              <MessageList conversation={selected} onImageClick={setPreview} />
              <ChatInput onSend={send} />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-purple-500/20">
                <MessageCircle className="h-10 w-10 text-purple-400" />
              </div>
              <h2 className="mb-2 text-xl font-semibold text-white">Welcome to Argus</h2>
              <p className="max-w-sm text-white/40">Select a conversation to start messaging.</p>
            </div>
          )}
        </div>
      </div>
      <ImagePreviewModal src={preview} onClose={() => setPreview(null)} />
      {recoveryOpen && <RecoveryPanel onClose={() => setRecoveryOpen(false)} />}
    </div>
  );
}
