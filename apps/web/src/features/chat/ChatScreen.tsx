import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import type { UserSummary } from '../../lib/api';
import { ConversationManager, type ConversationSession } from '../../lib/conversations';
import { joinPendingConversations } from '../../lib/join';
import { getMlsSession } from '../../lib/mls';
import { useAuth } from '../auth/AuthContext';
import { useDevice } from '../device/DeviceContext';
import { RecoveryPanel } from '../recovery/RecoveryPanel';
import { ConversationList } from './ConversationList';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ImagePreviewModal } from './ImagePreviewModal';
import { StartConversation } from './StartConversation';
import { VerifySecurity } from './VerifySecurity';
import type { Attachment, Conversation, Message, User } from './seed';
import {
  conversations as initialConversations,
  currentUser,
  generatedAvatar,
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
  // Each direct conversation has its own MLS session, so its own safety number (#20).
  const [numbersByConv, setNumbersByConv] = useState<Record<string, string>>({});
  // Per-conversation verification: conversationId → the safety number marked verified for it.
  const [verifiedByConv, setVerifiedByConv] = useState<Record<string, string>>({});

  const { device, pool, deviceId } = useDevice();
  const { profile } = useAuth();
  // A live conversation manager exists only with an unlocked device (not demo mode). New conversations
  // route through it (claim → #20 gate → create + deliver); demo mode keeps the seed/loopback path.
  const manager = useMemo(
    () => (device && profile?.userId ? new ConversationManager(device, profile.userId) : null),
    [device, profile],
  );
  const [startOpen, setStartOpen] = useState(false);
  // Conversations JOINED on connect (Slice 4): their ids drive the live-conversation checks below, and
  // their in-memory MLS groups are retained (ref) for Slice 5's send/fetch.
  const [joinedIds, setJoinedIds] = useState<Set<string>>(() => new Set());
  const joinedGroups = useRef(new Map<string, MlsGroup>());
  const joinRanRef = useRef(false);

  // A conversation is "live" (real MLS, no send path until Slice 5) if it was started via the manager OR
  // joined on connect. Demo/seed conversations are not live and keep the loopback path.
  const isLive = (id: string | null): boolean => !!id && (!!manager?.get(id) || joinedIds.has(id));

  useEffect(() => {
    setMounted(true);
  }, []);

  // Add a freshly-started LIVE conversation to the list: its safety number is the REAL one from the
  // session (not a loopback), and the user just confirmed it out-of-band, so it lands pre-verified.
  const handleStarted = (session: ConversationSession, peer: UserSummary): void => {
    const name = peer.displayName || peer.email;
    const peerUser: User = { id: peer.id, name, avatar: generatedAvatar(name), isOnline: false };
    setConversations((prev) =>
      prev.some((c) => c.id === session.conversationId)
        ? prev
        : [
            {
              id: session.conversationId,
              type: 'direct',
              participants: [currentUser, peerUser],
              messages: [],
              unreadCount: 0,
            },
            ...prev,
          ],
    );
    setNumbersByConv((prev) => ({ ...prev, [session.conversationId]: session.safetyNumber }));
    setVerifiedByConv((prev) => ({ ...prev, [session.conversationId]: session.safetyNumber }));
    setSelectedId(session.conversationId);
    setStartOpen(false);
  };

  // Join on connect (Slice 4): once unlocked + provisioned, drain pending Welcomes into live conversations.
  // Runs once per session. onJoined surfaces each joined conversation (placeholder peer — the inviter's
  // identity isn't in the welcome list yet; join-conversation.md §6) and retains its MLS group for Slice 5.
  useEffect(() => {
    if (!device || !pool || !deviceId || joinRanRef.current) return;
    joinRanRef.current = true;
    joinPendingConversations({
      device,
      pool,
      deviceId,
      onJoined: ({ conversationId, conversation }) => {
        joinedGroups.current.set(conversationId, conversation);
        setJoinedIds((prev) =>
          prev.has(conversationId) ? prev : new Set(prev).add(conversationId),
        );
        setConversations((prev) =>
          prev.some((c) => c.id === conversationId)
            ? prev
            : [
                {
                  id: conversationId,
                  type: 'direct',
                  participants: [
                    currentUser,
                    {
                      id: `peer-${conversationId}`,
                      name: 'New contact',
                      avatar: generatedAvatar(conversationId),
                      isOnline: false,
                    },
                  ],
                  messages: [],
                  unreadCount: 0,
                },
                ...prev,
              ],
        );
      },
    }).catch((err: unknown) => {
      // A whole-drain failure (e.g. listWelcomes errored) is not retried this session; it rides the next
      // unlock and Slice 5's reconnect-sync. Per-Welcome failures are already isolated inside the drain.
      // eslint-disable-next-line no-console
      console.warn('join-on-connect drain failed', err instanceof Error ? err.message : err);
    });
  }, [device, pool, deviceId]);

  const selectedConversation = conversations.find((c) => c.id === selectedId);
  // Safety-number verification is 2-party only (group safety numbers are deferred —
  // fingerprint-verification.md §6) and per-conversation.
  const isDirect = selectedConversation?.type === 'direct';

  // Compute the selected DIRECT conversation's own safety number (from its own loopback session), once.
  // LIVE conversations (started or joined) are skipped — a started one already holds its REAL number, and
  // neither should spin up a loopback session (which would compute the wrong, local number).
  useEffect(() => {
    if (!selectedId || !isDirect || !!manager?.get(selectedId) || joinedIds.has(selectedId)) return;
    void getMlsSession(selectedId)
      .then((s) =>
        setNumbersByConv((prev) =>
          prev[selectedId] ? prev : { ...prev, [selectedId]: s.safetyNumber },
        ),
      )
      .catch(() => {});
  }, [selectedId, isDirect, manager, joinedIds]);

  const currentNumber = selectedId ? (numbersByConv[selectedId] ?? null) : null;
  // Verified only while the number marked for THIS conversation still matches the current key.
  const verified =
    !!isDirect &&
    selectedId !== null &&
    currentNumber !== null &&
    verifiedByConv[selectedId] === currentNumber;

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
    // Live conversations (started OR joined) have no send path yet (Slice 5). Never route them through the
    // demo loopback (`getMlsSession`) — that would mark a message "encrypted/delivered/read" after a LOCAL
    // round-trip even though nothing was sent to the peer, who could never receive it. The composer is
    // disabled for live conversations; this is the defensive guard. Demo/seed conversations keep loopback.
    if (isLive(convId)) return;
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
        const session = await getMlsSession(convId);
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
            onNewConversation={manager ? () => setStartOpen(true) : undefined}
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
                onVerify={isDirect && currentNumber ? () => setVerifyOpen(true) : undefined}
              />
              <MessageList conversation={selectedConversation} onImageClick={setPreviewImage} />
              <ChatInput
                onSend={handleSend}
                disabled={isLive(selectedConversation.id)}
                disabledNotice="This conversation is encrypted and ready — live messaging arrives in the next update."
              />
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
      {startOpen && manager && (
        <StartConversation
          manager={manager}
          selfUserId={profile?.userId}
          onStarted={handleStarted}
          onClose={() => setStartOpen(false)}
        />
      )}
      {verifyOpen && isDirect && (
        <VerifySecurity
          peerName={
            selectedConversation
              ? getConversationDisplayName(selectedConversation, currentUser.id)
              : 'this contact'
          }
          safetyNumber={currentNumber}
          verified={verified}
          onVerifiedChange={(v) =>
            setVerifiedByConv((prev) => {
              const next = { ...prev };
              if (v && selectedId && currentNumber) next[selectedId] = currentNumber;
              else if (selectedId) delete next[selectedId];
              return next;
            })
          }
          onClose={() => setVerifyOpen(false)}
        />
      )}
    </div>
  );
}
