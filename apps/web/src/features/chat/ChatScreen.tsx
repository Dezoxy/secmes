import { useEffect, useMemo, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { UserSummary } from '../../lib/api';
import { ConversationManager, type ConversationSession } from '../../lib/conversations';
import type { MessagingDeps } from '../../lib/messaging';
import { getMlsSession } from '../../lib/mls';
import { useAuth } from '../auth/AuthContext';
import { useDevice } from '../device/DeviceContext';
import { ConversationList } from './ConversationList';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ImagePreviewModal } from './ImagePreviewModal';
import { StartConversation } from './StartConversation';
import { contactDisplayName } from './user-label';
import { VerifySecurity } from './VerifySecurity';
import {
  useConversationBackfill,
  useConversationHistoryRehydration,
  useSelectedConversationBackfill,
} from './useConversationBackfill';
import { useChatState } from './useChatState';
import { useLiveConversations } from './useLiveConversations';
import { useMessageSending } from './useMessageSending';
import { loadArgusProfile, saveArgusProfile } from '../settings/argus-profile';
import { SettingsPanel, type AnonymousProfile } from '../settings/SettingsPanel';
import { conversationEnterMotion } from '../ui';
import type { Conversation, User } from './seed';
import {
  conversations as initialConversations,
  currentUser,
  generatedAvatar,
  getConversationDisplayName,
  safeAvatarSrc,
} from './seed';

const DEMO_PROFILE_SUBJECT = 'demo-local';

/**
 * Chat experience, ported from the reworked design (`~/Downloads`) into the Vite PWA.
 *
 * Conversations come from a local seed, but SENDING runs a real in-browser MLS (RFC 9420) encrypt→
 * decrypt round-trip via @argus/crypto (lib/mls.ts) — proving the E2EE path (a lock appears once a
 * message is through it; a failed round-trip marks it failed, never sent). The live loop swaps the
 * local peer for a remote member over the WS gateway and back-fills history by decrypting fetched
 * ciphertext; it needs the key directory + out-of-band fingerprint verification (#20). No plaintext
 * leaves the browser. The settings button opens profile, privacy, and key-recovery controls.
 */
// The sidebar entry for a LIVE conversation surfaced without a known peer identity (joined on connect, or
// rehydrated on unlock). The inviter's identity isn't in the welcome/persistence metadata (it would leak the
// social graph to the server), so we show a neutral placeholder; verification (#20) names it out-of-band.
function currentUserFromProfile(profile: AnonymousProfile): User {
  return {
    ...currentUser,
    name: profile.username,
    avatar: profile.avatar,
    isOnline: true,
  };
}

function withCurrentUserProfile(conversation: Conversation, profile: User): Conversation {
  return {
    ...conversation,
    participants: conversation.participants.map((participant) =>
      participant.id === currentUser.id
        ? {
            ...participant,
            name: profile.name,
            avatar: profile.avatar,
            isOnline: profile.isOnline,
          }
        : participant,
    ),
  };
}

export default function ChatScreen() {
  const [mounted, setMounted] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [selectedId, setSelectedId] = useState<string | null>('conv-1');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  // Each direct conversation has its own MLS session, so its own safety number (#20).
  const [numbersByConv, setNumbersByConv] = useState<Record<string, string>>({});
  // Per-conversation verification: conversationId → the safety number marked verified for it.
  const [verifiedByConv, setVerifiedByConv] = useState<Record<string, string>>({});

  const { device, pool, deviceId, keystore, passphrase, sessionKey } = useDevice();
  const { profile, subjectId } = useAuth();
  const profileSubjectId = subjectId ?? DEMO_PROFILE_SUBJECT;
  const [anonymousProfile, setAnonymousProfile] = useState<AnonymousProfile>(() =>
    loadArgusProfile({ subjectId: profileSubjectId }),
  );
  const currentUserProfile = useMemo(
    () => currentUserFromProfile(anonymousProfile),
    [anonymousProfile],
  );
  // What every live send/receive needs to seal the advanced ratchet at rest (Slice 5). Null in demo mode.
  const messagingDeps = useMemo<MessagingDeps | null>(
    () => (device && keystore && passphrase ? { device, keystore, passphrase } : null),
    [device, keystore, passphrase],
  );
  // A live conversation manager exists only with an unlocked device (not demo mode). New conversations
  // route through it (claim → #20 gate → create + persist + deliver); demo mode keeps the seed/loopback path.
  const manager = useMemo(
    () =>
      messagingDeps && profile?.userId
        ? new ConversationManager(
            messagingDeps.device,
            profile.userId,
            messagingDeps.keystore,
            messagingDeps.passphrase,
          )
        : null,
    [messagingDeps, profile],
  );
  const [startOpen, setStartOpen] = useState(false);
  const { appendHistory, mergeIncoming, backfillInto } = useConversationBackfill({
    messagingDeps,
    sessionKey,
    setConversations,
  });

  const { liveIds, liveGroups, addLive } = useLiveConversations({
    device,
    pool,
    deviceId,
    messagingDeps,
    selfUserId: profile?.userId,
    currentUserProfile,
    mergeIncoming,
    backfillInto,
    setConversations,
  });

  const { selectedConversation, isDirect, selectedIsLive, currentNumber, verified, isLive } =
    useChatState({
      conversations,
      selectedId,
      liveIds,
      numbersByConv,
      verifiedByConv,
    });

  const handleSend = useMessageSending({
    selectedId,
    isLive,
    liveGroups,
    messagingDeps,
    appendHistory,
    setConversations,
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setAnonymousProfile(loadArgusProfile({ subjectId: profileSubjectId }));
  }, [profileSubjectId]);

  useEffect(() => {
    setConversations((prev) =>
      prev.map((conversation) => withCurrentUserProfile(conversation, currentUserProfile)),
    );
  }, [currentUserProfile]);

  const handleProfileChange = (next: AnonymousProfile): boolean => {
    const safeNext = {
      ...next,
      avatar: safeAvatarSrc(next.avatar, next.username || next.id),
    };
    if (saveArgusProfile({ subjectId: profileSubjectId, profile: safeNext })) {
      setAnonymousProfile(loadArgusProfile({ subjectId: profileSubjectId }));
      return true;
    }
    return false;
  };

  // Add a freshly-started LIVE conversation to the list: its safety number is the REAL one from the
  // session (not a loopback), and the user just confirmed it out-of-band, so it lands pre-verified.
  const handleStarted = (session: ConversationSession, peer: UserSummary): void => {
    const name = contactDisplayName(peer);
    const peerUser: User = {
      id: peer.id,
      name,
      avatar: generatedAvatar(`${name} ${peer.id}`),
      isOnline: false,
    };
    addLive(session.conversationId, session.conversation); // retain its MLS group for live send/fetch
    setConversations((prev) =>
      prev.some((c) => c.id === session.conversationId)
        ? prev
        : [
            {
              id: session.conversationId,
              type: 'direct',
              participants: [currentUserProfile, peerUser],
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

  useConversationHistoryRehydration({
    messagingDeps,
    sessionKey,
    currentUserProfile,
    addLive,
    setConversations,
  });

  // Compute the selected DIRECT conversation's own safety number (from its own loopback session), once.
  // LIVE conversations are skipped — a started one already holds its REAL number, and none should spin up a
  // loopback session (which would compute the wrong, local number).
  useEffect(() => {
    if (!selectedId || !isDirect || selectedIsLive) return;
    void getMlsSession(selectedId)
      .then((s) =>
        setNumbersByConv((prev) =>
          prev[selectedId] ? prev : { ...prev, [selectedId]: s.safetyNumber },
        ),
      )
      .catch(() => {});
  }, [selectedId, isDirect, selectedIsLive]);

  useSelectedConversationBackfill({
    selectedId,
    selectedIsLive,
    selfUserId: profile?.userId,
    liveGroups,
    backfillInto,
  });

  const handleSelect = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) setShowSidebar(false);
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
          <div className="border-b border-white/5 p-4">
            <div className="flex items-center justify-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500">
                <MessageCircle className="h-4 w-4 text-white" />
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
            currentUserProfile={currentUserProfile}
            onSettings={() => setSettingsOpen(true)}
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
            <div
              key={selectedConversation.id}
              className={`flex min-h-0 flex-1 flex-col ${conversationEnterMotion}`}
            >
              <ChatHeader
                conversation={selectedConversation}
                onBack={() => setShowSidebar(true)}
                verified={verified}
                onVerify={isDirect && currentNumber ? () => setVerifyOpen(true) : undefined}
              />
              <MessageList conversation={selectedConversation} onImageClick={setPreviewImage} />
              <ChatInput onSend={handleSend} />
            </div>
          ) : (
            <div
              key="empty-conversation"
              className={`flex flex-1 flex-col items-center justify-center p-8 text-center ${conversationEnterMotion}`}
            >
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
      {settingsOpen && (
        <SettingsPanel
          profile={anonymousProfile}
          deviceId={deviceId}
          onProfileChange={handleProfileChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
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
