import { useEffect, useRef, useState } from 'react';
import { Users, Unplug } from 'lucide-react';
import { prefersReducedMotion } from '../../lib/pref';
import { demoMode } from '../../lib/auth';
import { ArgusAppIcon } from '../brand/ArgusAppIcon';
import { ConversationList } from '../chat/ConversationList';
import { ChatHeader } from '../chat/ChatHeader';
import { MessageList } from '../chat/MessageList';
import { ChatInput } from '../chat/ChatInput';
import { GroupCreateDialog } from '../chat/GroupCreateDialog';
import { ImagePreviewModal } from '../chat/ImagePreviewModal';
import { contactDisplayName } from '../chat/user-label';
import { dicebearAvatar } from '../../lib/dicebear';
import { useSelectedConversationBackfill } from '../chat/useConversationBackfill';
import { useChatState } from '../chat/useChatState';
import { useMessageSending } from '../chat/useMessageSending';
import { useReceiptSending } from '../chat/useReceiptSending';
import { useChatContext } from '../chat/ChatContext';
import { tabSelectedId } from '../chat/tabSelectedId';
import {
  ReconnectBanner,
  StateBlock,
  conversationEnterMotion,
  paneBackEnterMotion,
  paneBackExitMotion,
} from '../ui';

export default function GroupsScreen() {
  const {
    conversations,
    setConversations,
    groupManager,
    messagingDeps,
    liveIds,
    liveGroups,
    connectionStatus,
    appendHistory,
    backfillInto,
    serverProfile: profile,
    numbersByConv,
    verifiedByConv,
    updateReady,
    applyUpdate,
    persistGroupCreated,
  } = useChatContext();

  const groupConversations = conversations.filter((c) => c.type === 'group');

  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(tabSelectedId.get('/groups') ?? null);
  useEffect(() => {
    tabSelectedId.set('/groups', selectedId);
  }, [selectedId]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [mobileThreadClosing, setMobileThreadClosing] = useState(false);
  const [mobileSidebarReturning, setMobileSidebarReturning] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const mobileThreadBackTimerRef = useRef<number | undefined>(undefined);
  const mobileSidebarReturnTimerRef = useRef<number | undefined>(undefined);

  const { selectedConversation, selectedIsLive, isLive } = useChatState({
    conversations: groupConversations,
    selectedId,
    liveIds,
    numbersByConv,
    verifiedByConv,
  });

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

  useReceiptSending({ conversations: groupConversations, liveIds, selectedId, selectedIsLive });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    return () => {
      if (mobileThreadBackTimerRef.current !== undefined)
        window.clearTimeout(mobileThreadBackTimerRef.current);
      if (mobileSidebarReturnTimerRef.current !== undefined)
        window.clearTimeout(mobileSidebarReturnTimerRef.current);
    };
  }, []);

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

  return (
    <div className="relative flex h-full bg-[#1a1a24] sm:items-center sm:justify-center sm:p-4">
      <div
        className={`absolute inset-0 w-full sm:static sm:h-[calc(100%-2rem)] sm:max-w-6xl bg-[#12121a] sm:rounded-3xl overflow-hidden flex shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        {/* Sidebar */}
        <aside
          aria-label="Group conversations"
          className={`${
            showSidebar && !mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } w-full lg:w-80 shrink-0 flex-col bg-[#0f0f16] border-r border-white/5 transition-all duration-500 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8'
          } ${mobileSidebarReturning ? paneBackEnterMotion : ''}`}
        >
          <div className="border-b border-white/5 bg-[#0f0f16]/75 p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] backdrop-blur-xl">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-purple-500/25" />
                <span className="text-xl font-bold tracking-wider">
                  <span className="bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
                    GROUPS
                  </span>
                </span>
              </div>
              {groupManager && messagingDeps && (
                <button
                  type="button"
                  onClick={() => setGroupCreateOpen(true)}
                  className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:border-purple-500/30 hover:bg-purple-500/10 hover:text-purple-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                  aria-label="Create new group"
                >
                  <Users className="h-3.5 w-3.5" />
                  New group
                </button>
              )}
            </div>
          </div>

          <ConversationList
            conversations={groupConversations}
            selectedId={selectedId}
            onSelect={handleSelect}
            updateReady={updateReady}
            onApplyUpdate={applyUpdate}
          />
        </aside>

        {/* Main */}
        <div
          role="main"
          aria-label="Group chat"
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
                verified={false}
                onVerify={undefined}
                onAddMember={
                  selectedConversation.creatorId === profile?.userId &&
                  liveGroups.current.has(selectedConversation.id) &&
                  !selectedIsSyncLost
                    ? () => setAddMemberOpen(true)
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
              key="empty-group"
              className={`flex flex-1 flex-col items-center justify-center p-8 text-center ${conversationEnterMotion}`}
            >
              <div className="w-20 h-20 bg-purple-500/20 rounded-full flex items-center justify-center mb-4">
                <Users className="w-10 h-10 text-purple-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Group chats</h2>
              <p className="text-white/60 max-w-sm">
                {groupManager
                  ? 'Select a group or tap "New group" to create one'
                  : 'Select a group conversation to start messaging'}
              </p>
            </div>
          )}
        </div>
      </div>

      <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />

      {groupCreateOpen && groupManager && messagingDeps && (
        <GroupCreateDialog
          mode="create"
          manager={groupManager}
          deps={messagingDeps}
          selfUserId={profile?.userId}
          onCreated={(session) => {
            persistGroupCreated(session);
            setSelectedId(session.conversationId);
            setGroupCreateOpen(false);
            if (window.innerWidth < 1024) setShowSidebar(false);
          }}
          onClose={() => setGroupCreateOpen(false)}
        />
      )}
      {addMemberOpen && selectedId && groupManager && messagingDeps && (
        <GroupCreateDialog
          mode="add"
          manager={groupManager}
          deps={messagingDeps}
          selfUserId={profile?.userId}
          conversationId={selectedId}
          existingConversation={liveGroups.current.get(selectedId)}
          existingMemberIds={new Set(selectedConversation?.participants.map((p) => p.id) ?? [])}
          existingGroupName={selectedConversation?.name}
          onAdded={(addedUsers) => {
            setAddMemberOpen(false);
            if (addedUsers.length > 0 && selectedId) {
              setConversations((prev) =>
                prev.map((c) => {
                  if (c.id !== selectedId) return c;
                  const existingIds = new Set(c.participants.map((p) => p.id));
                  const fresh = addedUsers
                    .filter((u) => !existingIds.has(u.userId))
                    .map((u) => ({
                      id: u.userId,
                      name: contactDisplayName(u),
                      argusId: u.argusId,
                      avatar: dicebearAvatar(u.userId),
                    }));
                  return fresh.length === 0
                    ? c
                    : { ...c, participants: [...c.participants, ...fresh] };
                }),
              );
            }
          }}
          onClose={() => setAddMemberOpen(false)}
        />
      )}
    </div>
  );
}
