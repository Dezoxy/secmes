import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Unplug } from 'lucide-react';
import { getMlsSession } from '../../lib/mls';
import { prefersReducedMotion } from '../../lib/pref';
import { demoMode } from '../../lib/auth';
import { ArgusAppIcon } from '../brand/ArgusAppIcon';
import { ConversationList } from './ConversationList';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ImagePreviewModal } from './ImagePreviewModal';
import { StartConversation } from './StartConversation';
import { ApproveDevicePanel } from '../device/ApproveDevicePanel';
import { VerifySecurity } from './VerifySecurity';
import { useSelectedConversationBackfill } from './useConversationBackfill';
import { tabSelectedId } from './tabSelectedId';
import { useChatState } from './useChatState';
import { useMessageSending } from './useMessageSending';
import { useReceiptSending } from './useReceiptSending';
import { useChatContext } from './ChatContext';
import {
  ReconnectBanner,
  StateBlock,
  conversationEnterMotion,
  paneBackEnterMotion,
  paneBackExitMotion,
} from '../ui';
import { currentUser, getConversationDisplayName } from './seed';
import { loadPersistedPeerMapping } from './peer-naming';
import { safetyNumberFromMember } from '@argus/crypto';
import { useLocation } from 'react-router-dom';

export default function ChatScreen() {
  const location = useLocation();
  const locationState = location.state as
    | { selectedId?: string; startArgusId?: string }
    | null
    | undefined;

  const {
    conversations,
    setConversations,
    manager,
    messagingDeps,
    liveIds,
    liveGroups,
    connectionStatus,
    appendHistory,
    backfillInto,
    serverProfile: profile,
    numbersByConv,
    setNumbersByConv,
    verifiedByConv,
    setVerifiedByConv,
    peerKeyChangedConvId,
    setPeerKeyChangedConvId,
    pendingEnrollmentId,
    setPendingEnrollmentId,
    updateReady,
    applyUpdate,
    persistStartedConversation,
  } = useChatContext();

  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    demoMode ? 'conv-1' : (locationState?.selectedId ?? tabSelectedId.get('/chat') ?? null),
  );
  useEffect(() => {
    if (!demoMode) tabSelectedId.set('/chat', selectedId);
  }, [selectedId]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(!locationState?.selectedId);
  const [mobileThreadClosing, setMobileThreadClosing] = useState(false);
  const [mobileSidebarReturning, setMobileSidebarReturning] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(!!locationState?.startArgusId);
  const [startPrefillArgusId, setStartPrefillArgusId] = useState<string | undefined>(
    locationState?.startArgusId,
  );
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const mobileThreadBackTimerRef = useRef<number | undefined>(undefined);
  const mobileSidebarReturnTimerRef = useRef<number | undefined>(undefined);

  const { selectedConversation, isDirect, selectedIsLive, currentNumber, verified, isLive } =
    useChatState({ conversations, selectedId, liveIds, numbersByConv, verifiedByConv });

  const effectiveSelectedIsLive = demoMode ? !!selectedId : selectedIsLive;
  const selectedIsSyncLost = selectedConversation?.recovery === 'sync-lost';

  const handleSend = useMessageSending({
    selectedId,
    isLive,
    liveGroups,
    messagingDeps,
    appendHistory,
    setConversations,
  });

  useReceiptSending({ conversations, liveIds, selectedId, selectedIsLive });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (peerKeyChangedConvId !== null && peerKeyChangedConvId === selectedId) {
      setVerifyOpen(true);
    }
  }, [peerKeyChangedConvId, selectedId]);

  useEffect(() => {
    return () => {
      if (mobileThreadBackTimerRef.current !== undefined)
        window.clearTimeout(mobileThreadBackTimerRef.current);
      if (mobileSidebarReturnTimerRef.current !== undefined)
        window.clearTimeout(mobileSidebarReturnTimerRef.current);
    };
  }, []);

  // Compute the loopback safety number for direct non-live conversations.
  useEffect(() => {
    if (!selectedId || !isDirect || selectedIsLive || selectedIsSyncLost) return;
    void getMlsSession(selectedId)
      .then((s) =>
        setNumbersByConv((prev) =>
          prev[selectedId] ? prev : { ...prev, [selectedId]: s.safetyNumber },
        ),
      )
      .catch(() => {});
  }, [selectedId, isDirect, selectedIsLive, selectedIsSyncLost, setNumbersByConv]);

  useSelectedConversationBackfill({
    selectedId,
    selectedIsLive,
    selfUserId: profile?.userId,
    liveGroups,
    backfillInto,
  });

  const handleSelect = (id: string) => {
    if (mobileThreadBackTimerRef.current !== undefined)
      window.clearTimeout(mobileThreadBackTimerRef.current);
    if (mobileSidebarReturnTimerRef.current !== undefined)
      window.clearTimeout(mobileSidebarReturnTimerRef.current);
    setMobileThreadClosing(false);
    setMobileSidebarReturning(false);
    setSelectedId(id);
    if (window.innerWidth < 1024) setShowSidebar(false);
  };

  const handleBackToConversations = () => {
    if (window.innerWidth >= 1024 || prefersReducedMotion()) {
      setShowSidebar(true);
      return;
    }
    if (mobileThreadBackTimerRef.current !== undefined)
      window.clearTimeout(mobileThreadBackTimerRef.current);
    if (mobileSidebarReturnTimerRef.current !== undefined)
      window.clearTimeout(mobileSidebarReturnTimerRef.current);
    setMobileThreadClosing(true);
    mobileThreadBackTimerRef.current = window.setTimeout(() => {
      setShowSidebar(true);
      setMobileThreadClosing(false);
      setMobileSidebarReturning(true);
      mobileSidebarReturnTimerRef.current = window.setTimeout(() => {
        setMobileSidebarReturning(false);
      }, 220);
    }, 180);
  };

  const findConversationWith = (peerUserId: string): string | null =>
    conversations.find(
      (c) => c.type === 'direct' && c.participants.some((p) => p.id === peerUserId),
    )?.id ?? null;

  const handleOpenExisting = (conversationId: string): void => {
    setSelectedId(conversationId);
    setStartOpen(false);
    setStartPrefillArgusId(undefined);
  };

  const handleStarted = useCallback(
    (
      session: Parameters<typeof persistStartedConversation>[0],
      peer: Parameters<typeof persistStartedConversation>[1],
    ) => {
      persistStartedConversation(session, peer);
      setSelectedId(session.conversationId);
      setStartOpen(false);
      setStartPrefillArgusId(undefined);
      if (window.innerWidth < 1024) setShowSidebar(false);
    },
    [persistStartedConversation],
  );

  const handleOpenAddMember = (): void => {
    if (!selectedId) return;
    if (!liveGroups.current.has(selectedId)) return;
    setAddMemberOpen(true);
  };

  return (
    <div className="relative flex h-full bg-[#1a1a24] sm:items-center sm:justify-center sm:p-4">
      <div
        className={`absolute inset-0 w-full sm:static sm:h-[calc(100%-2rem)] sm:max-w-6xl bg-[#12121a] sm:rounded-3xl overflow-hidden flex shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        {/* Sidebar */}
        <aside
          aria-label="Conversations"
          className={`${
            showSidebar && !mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } w-full lg:w-80 shrink-0 flex-col bg-[#0f0f16] border-r border-white/5 transition-all duration-500 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8'
          } ${mobileSidebarReturning ? paneBackEnterMotion : ''}`}
        >
          <div className="border-b border-white/5 bg-[#0f0f16]/75 p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] backdrop-blur-xl">
            <div className="flex items-center justify-center gap-2">
              <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-purple-500/25" />
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
            updateReady={updateReady}
            onApplyUpdate={applyUpdate}
          />
        </aside>

        {/* Main */}
        <div
          role="main"
          aria-label="Chat"
          className={`${
            !showSidebar || mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } flex-1 flex-col transition-all duration-500 delay-100 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
          } ${mobileThreadClosing ? paneBackExitMotion : ''}`}
        >
          {selectedConversation ? (
            <div
              key={selectedConversation.id}
              className={`flex min-h-0 flex-1 flex-col ${conversationEnterMotion}`}
            >
              <ChatHeader
                conversation={selectedConversation}
                onBack={handleBackToConversations}
                verified={verified}
                onVerify={isDirect && currentNumber ? () => setVerifyOpen(true) : undefined}
                onAddMember={
                  selectedConversation.type === 'group' &&
                  selectedConversation.creatorId === profile?.userId &&
                  liveGroups.current.has(selectedConversation.id) &&
                  !selectedIsSyncLost
                    ? handleOpenAddMember
                    : undefined
                }
                updateReady={updateReady}
                onApplyUpdate={applyUpdate}
              />
              {effectiveSelectedIsLive && !selectedIsSyncLost && (
                <ReconnectBanner status={connectionStatus} className="mx-4 mt-3" />
              )}
              {selectedIsSyncLost && (
                <StateBlock
                  icon={Unplug}
                  title="Conversation out of sync"
                  variant="offline"
                  compact
                  role="status"
                  ariaLive="polite"
                  className="mx-4 mt-3"
                >
                  This conversation fell too far behind to sync. New messages may not appear and
                  older ones may be unavailable.
                </StateBlock>
              )}
              <MessageList conversation={selectedConversation} onImageClick={setPreviewImage} />
              {effectiveSelectedIsLive && !selectedIsSyncLost && <ChatInput onSend={handleSend} />}
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
              <p className="text-white/60 max-w-sm">
                Select a conversation from the sidebar to start messaging
              </p>
            </div>
          )}
        </div>
      </div>

      <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />
      {startOpen && manager && (
        <StartConversation
          manager={manager}
          selfUserId={profile?.userId}
          existingConversationWith={findConversationWith}
          onOpenExisting={handleOpenExisting}
          onStarted={handleStarted}
          prefillArgusId={startPrefillArgusId}
          onClose={() => {
            setStartOpen(false);
            setStartPrefillArgusId(undefined);
          }}
        />
      )}
      {addMemberOpen && selectedId && messagingDeps && (
        <StartConversation
          manager={manager!}
          selfUserId={profile?.userId}
          existingConversationWith={findConversationWith}
          onOpenExisting={handleOpenExisting}
          onStarted={handleStarted}
          onClose={() => setAddMemberOpen(false)}
        />
      )}
      {pendingEnrollmentId && profile?.userId && (
        <ApproveDevicePanel
          enrollmentId={pendingEnrollmentId}
          selfUserId={profile.userId}
          messagingDeps={messagingDeps}
          liveGroupsRef={liveGroups}
          onClose={() => setPendingEnrollmentId(null)}
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
          keyChanged={selectedId !== null && peerKeyChangedConvId === selectedId}
          onVerifiedChange={(v) => {
            setVerifiedByConv((prev) => {
              const next = { ...prev };
              if (v && selectedId && currentNumber) next[selectedId] = currentNumber;
              else if (selectedId) delete next[selectedId];
              return next;
            });
            if (v && selectedId) setPeerKeyChangedConvId(null);
            if (selectedId && messagingDeps) {
              const { device, keystore, sessionKey } = messagingDeps;
              const peerUserId = loadPersistedPeerMapping(selectedId);
              if (peerUserId) {
                if (!v) {
                  void keystore.deleteVerifiedPeer(peerUserId);
                } else {
                  const liveGroup = liveGroups.current.get(selectedId);
                  if (liveGroup) {
                    void (async () => {
                      try {
                        const members = liveGroup.members();
                        const selfSigKey = device.publicPackage.leafNode.signaturePublicKey;
                        const selfMember = members.find((m) => {
                          if (m.signaturePublicKey.length !== selfSigKey.length) return false;
                          for (let i = 0; i < selfSigKey.length; i++) {
                            if (m.signaturePublicKey[i] !== selfSigKey[i]) return false;
                          }
                          return true;
                        });
                        if (!selfMember) return;
                        const peerMembers = members.filter(
                          (m) => m.identity !== selfMember!.identity,
                        );
                        if (peerMembers.length === 0) return;
                        const nums: string[] = await Promise.all(
                          peerMembers.map((pm) => safetyNumberFromMember(selfMember, pm)),
                        );
                        const sorted = [...new Set(nums)].sort();
                        await keystore.saveVerifiedPeer(peerUserId, sorted, sessionKey);
                      } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn(
                          'could not persist verified peer',
                          err instanceof Error ? err.message : err,
                        );
                      }
                    })();
                  }
                }
              }
            }
          }}
          onClose={() => setVerifyOpen(false)}
        />
      )}
    </div>
  );
}
