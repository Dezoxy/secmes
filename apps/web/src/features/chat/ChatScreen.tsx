import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import type { UserSummary } from '../../lib/api';
import { accessToken } from '../../lib/auth';
import { ConversationManager, type ConversationSession } from '../../lib/conversations';
import { joinPendingConversations } from '../../lib/join';
import { GroupStateConflict, type StoredMessage } from '../../lib/keystore';
import {
  backfillConversation,
  receiveLiveMessage,
  sendLiveMessage,
  type DecryptedMessage,
  type MessagingDeps,
} from '../../lib/messaging';
import { getMlsSession } from '../../lib/mls';
import { createMessageSocket, type MessageSocket } from '../../lib/ws';
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

// Map a persisted history entry back to a UI Message (timestamp string → Date). Plaintext stays local.
function storedToMessage(m: StoredMessage): Message {
  return {
    id: m.id,
    senderId: m.senderId,
    content: m.content,
    timestamp: new Date(m.timestamp),
    status: m.status as Message['status'],
    encrypted: m.encrypted,
  };
}

// The sidebar entry for a LIVE conversation surfaced without a known peer identity (joined on connect, or
// rehydrated on unlock). The inviter's identity isn't in the welcome/persistence metadata (it would leak the
// social graph to the server), so we show a neutral placeholder; verification (#20) names it out-of-band.
function liveConversationShell(conversationId: string): Conversation {
  return {
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
  };
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

  const { device, pool, deviceId, keystore, passphrase, sessionKey } = useDevice();
  const { profile } = useAuth();
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
  // LIVE conversations (real MLS over the network): started via the manager, joined on connect, or rehydrated
  // on unlock. `liveIds` drives the UI checks; `liveGroups` retains each in-memory MLS group for send/fetch.
  // `fetchCursors` is the per-conversation keyset high-water mark so re-opening fetches only newer messages.
  const [liveIds, setLiveIds] = useState<Set<string>>(() => new Set());
  const liveGroups = useRef(new Map<string, MlsGroup>());
  const fetchCursors = useRef(new Map<string, string>());
  const backfilling = useRef(new Set<string>());
  const backfillPending = useRef(new Set<string>());
  const socketRef = useRef<MessageSocket | null>(null);
  const joinRanRef = useRef(false);
  const rehydratedRef = useRef(false);

  // Persist messages to the local SEALED history log (fire-and-forget; upsert by id). Plaintext in →
  // sealed at rest under the session key. Only LIVE conversations call this (seed/demo convs aren't logged).
  const appendHistory = useCallback(
    (conversationId: string, entries: StoredMessage[]): void => {
      if (!messagingDeps || !sessionKey || entries.length === 0) return;
      void messagingDeps.keystore
        .appendMessages(messagingDeps.device, conversationId, sessionKey, entries)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            'persist history failed',
            conversationId,
            err instanceof Error ? err.message : err,
          );
        });
    },
    [messagingDeps, sessionKey],
  );

  // Merge decrypted incoming messages into a conversation, deduped by SERVER id (across fetch + WS push) and
  // kept in time order. Shared by fetch-on-open, the WS push, and reconnect catch-up. Also persists them to
  // the local sealed history so they survive a reload.
  const mergeIncoming = useCallback(
    (conversationId: string, incoming: DecryptedMessage[]): void => {
      if (incoming.length === 0) return;
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== conversationId) return c;
          const existing = new Set(c.messages.map((m) => m.id));
          const fresh: Message[] = incoming
            .filter((m) => !existing.has(m.serverId))
            .map((m) => ({
              id: m.serverId,
              senderId: m.senderUserId,
              content: m.plaintext,
              timestamp: new Date(m.createdAt),
              status: 'read',
              encrypted: true,
            }));
          if (fresh.length === 0) return c;
          return {
            ...c,
            messages: [...c.messages, ...fresh].sort(
              (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
            ),
          };
        }),
      );
      appendHistory(
        conversationId,
        incoming.map((m) => ({
          id: m.serverId,
          senderId: m.senderUserId,
          content: m.plaintext,
          timestamp: m.createdAt,
          status: 'read',
          encrypted: true,
        })),
      );
    },
    [appendHistory],
  );

  // Back-fill ONE live conversation from its keyset cursor → decrypt → merge. Drives both fetch-on-open and
  // the on-`subscribed` catch-up. A call that arrives while one is in flight does NOT drop — it COALESCES a
  // trailing rerun, so the ack-triggered catch-up still runs (with a fresh snapshot past the room-join) after
  // an in-flight fetch-on-open finishes; otherwise a message committed between that earlier fetch and the
  // gateway joining the room would be neither fetched nor pushed.
  const backfillInto = useCallback(
    async (conversationId: string, group: MlsGroup, selfUserId: string): Promise<void> => {
      if (!messagingDeps) return;
      if (backfilling.current.has(conversationId)) {
        backfillPending.current.add(conversationId); // one more pass after the in-flight one completes
        return;
      }
      backfilling.current.add(conversationId);
      try {
        do {
          backfillPending.current.delete(conversationId);
          const after = fetchCursors.current.get(conversationId);
          const { messages, cursor } = await backfillConversation(
            messagingDeps,
            conversationId,
            group,
            selfUserId,
            after,
          );
          if (cursor) fetchCursors.current.set(conversationId, cursor);
          mergeIncoming(conversationId, messages);
          // Loop once more iff a call arrived DURING this pass (its snapshot may post-date ours).
        } while (backfillPending.current.has(conversationId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('backfill failed', conversationId, err instanceof Error ? err.message : err);
      } finally {
        backfilling.current.delete(conversationId);
        backfillPending.current.delete(conversationId);
      }
    },
    [messagingDeps, mergeIncoming],
  );

  // Register a live conversation's MLS group and mark its id live (idempotent). The ref holds the group for
  // encrypt/decrypt; the id set is React state so the UI re-renders (enables the composer, drives `isLive`).
  // Also subscribe it on the realtime socket so the gateway pushes its messages.
  const addLive = (conversationId: string, conversation: MlsGroup): void => {
    liveGroups.current.set(conversationId, conversation);
    setLiveIds((prev) => (prev.has(conversationId) ? prev : new Set(prev).add(conversationId)));
    socketRef.current?.subscribe(conversationId);
  };

  // A conversation is "live" (real MLS over the network) iff it has a retained group. Demo/seed
  // conversations are not live and keep the local loopback round-trip.
  const isLive = (id: string | null): boolean => !!id && liveIds.has(id);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Add a freshly-started LIVE conversation to the list: its safety number is the REAL one from the
  // session (not a loopback), and the user just confirmed it out-of-band, so it lands pre-verified.
  const handleStarted = (session: ConversationSession, peer: UserSummary): void => {
    const name = peer.displayName || peer.email;
    const peerUser: User = { id: peer.id, name, avatar: generatedAvatar(name), isOnline: false };
    addLive(session.conversationId, session.conversation); // retain its MLS group for live send/fetch
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

  // Join on connect (Slice 4 + 5B): once unlocked + provisioned, drain pending Welcomes into live
  // conversations — now persisting each group (5A) then consuming its Welcome + pruning the spent private.
  // Runs once per session. onJoined surfaces each joined conversation (placeholder peer — the inviter's
  // identity isn't in the welcome list; join-conversation.md §6) and retains its MLS group for send/fetch.
  useEffect(() => {
    if (!device || !pool || !deviceId || !messagingDeps || joinRanRef.current) return;
    joinRanRef.current = true;
    joinPendingConversations({
      device,
      pool,
      deviceId,
      keystore: messagingDeps.keystore,
      passphrase: messagingDeps.passphrase,
      onJoined: ({ conversationId, conversation }) => {
        addLive(conversationId, conversation);
        setConversations((prev) =>
          prev.some((c) => c.id === conversationId)
            ? prev
            : [liveConversationShell(conversationId), ...prev],
        );
      },
    }).catch((err: unknown) => {
      // A whole-drain failure (e.g. listWelcomes errored) is not retried this session; it rides the next
      // unlock and Slice 5C's reconnect-sync. Per-Welcome failures are already isolated inside the drain.
      // eslint-disable-next-line no-console
      console.warn('join-on-connect drain failed', err instanceof Error ? err.message : err);
    });
  }, [device, pool, deviceId, messagingDeps]);

  // Rehydrate on unlock (Slice 5 + history): load every persisted conversation's sealed group state into a
  // live MLS group, seed its decrypted history from the sealed message log, and surface it. The group state
  // is how a conversation comes back (not a re-join); the message log is how its PLAINTEXT history comes back
  // (the ratchet can't re-derive consumed messages). Runs once per unlock; needs the session key for history.
  useEffect(() => {
    if (!messagingDeps || !sessionKey || rehydratedRef.current) return;
    rehydratedRef.current = true;
    const { keystore: ks, device: dev, passphrase: pass } = messagingDeps;
    const sKey = sessionKey;
    void (async () => {
      try {
        const restored = await ks.loadConversations(dev, pass);
        const logs = await ks.loadAllMessageLogs(dev, sKey);
        for (const [conversationId, conversation] of restored) {
          addLive(conversationId, conversation);
          const history = (logs.get(conversationId) ?? []).map(storedToMessage);
          setConversations((prev) =>
            prev.some((c) => c.id === conversationId)
              ? prev
              : [{ ...liveConversationShell(conversationId), messages: history }, ...prev],
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('rehydrate conversations failed', err instanceof Error ? err.message : err);
      }
    })();
  }, [messagingDeps, sessionKey]);

  const selectedConversation = conversations.find((c) => c.id === selectedId);
  // Safety-number verification is 2-party only (group safety numbers are deferred —
  // fingerprint-verification.md §6) and per-conversation.
  const isDirect = selectedConversation?.type === 'direct';

  // Compute the selected DIRECT conversation's own safety number (from its own loopback session), once.
  // LIVE conversations are skipped — a started one already holds its REAL number, and none should spin up a
  // loopback session (which would compute the wrong, local number).
  useEffect(() => {
    if (!selectedId || !isDirect || isLive(selectedId)) return;
    void getMlsSession(selectedId)
      .then((s) =>
        setNumbersByConv((prev) =>
          prev[selectedId] ? prev : { ...prev, [selectedId]: s.safetyNumber },
        ),
      )
      .catch(() => {});
  }, [selectedId, isDirect, liveIds]);

  // Fetch-on-open (Slice 5): when a LIVE conversation is selected, back-fill new ciphertext from the server,
  // decrypt it against the retained group, and append the peer's messages. The keyset cursor advances so a
  // re-open pulls only newer rows. Live PUSH (no re-open needed) is the WebSocket path below.
  useEffect(() => {
    if (!selectedId || !isLive(selectedId) || !profile?.userId) return;
    const group = liveGroups.current.get(selectedId);
    if (!group) return;
    void backfillInto(selectedId, group, profile.userId);
  }, [selectedId, liveIds, profile, backfillInto]);

  // Realtime push (Slice 5C): one reconnecting WebSocket to the `/ws` gateway, authenticated in the first
  // frame (never a token in the URL). It pushes ciphertext for the conversations we subscribe (each live
  // group, via addLive). On a message we decrypt + persist + merge (deduped by server id). Catch-up runs
  // per conversation on its `subscribed` ACK — only then is the socket in the gateway's room, so no message
  // can slip between the catch-up fetch and the live subscription.
  useEffect(() => {
    if (!messagingDeps || !profile?.userId) return;
    const deps = messagingDeps;
    const selfUserId = profile.userId;
    const socket = createMessageSocket({
      token: accessToken,
      onMessage: ({ conversationId, message }) => {
        const group = liveGroups.current.get(conversationId);
        if (!group) return; // a conversation we hold no keys for — ignore (can't decrypt)
        void receiveLiveMessage(deps, conversationId, group, message, selfUserId)
          .then((decrypted) => {
            if (decrypted) mergeIncoming(conversationId, [decrypted]);
          })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(
              'ws receive failed',
              conversationId,
              err instanceof Error ? err.message : err,
            );
          });
      },
      onSubscribed: (conversationId) => {
        const group = liveGroups.current.get(conversationId);
        if (group) void backfillInto(conversationId, group, selfUserId);
      },
    });
    socketRef.current = socket;
    for (const id of liveGroups.current.keys()) socket.subscribe(id); // subscribe any already-live convs
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [messagingDeps, profile, backfillInto, mergeIncoming]);

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

  // Live send (Slice 5): encrypt → persist the advanced ratchet → POST the ciphertext (all under the
  // conversation's single-writer lock, in lib/messaging). The local bubble echoes optimistically; the peer
  // receives it on their next fetch (5C makes that a live push). Attachments aren't transmitted on live
  // conversations yet (blob storage is a later feature) — only the text body is encrypted + sent.
  const sendLive = (
    convId: string,
    group: MlsGroup,
    deps: MessagingDeps,
    content: string,
  ): void => {
    const id = `msg-${crypto.randomUUID()}`;
    const message: Message = {
      id,
      senderId: currentUser.id,
      content,
      timestamp: new Date(),
      status: 'sending',
    };
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, message] } : c)),
    );
    const ts = message.timestamp.toISOString();
    const logSend = (status: string, encrypted = false): void =>
      appendHistory(convId, [
        { id, senderId: currentUser.id, content, timestamp: ts, status, encrypted },
      ]);
    logSend('sending');
    void (async () => {
      try {
        await sendLiveMessage(deps, convId, group, content);
        patchMessage(convId, id, { status: 'sent', encrypted: true });
        logSend('sent', true);
      } catch (err) {
        patchMessage(convId, id, { status: 'failed' });
        logSend('failed');
        // A GroupStateConflict means another tab advanced this conversation's durable state — this instance
        // is stale and must rehydrate to send. id/metadata only in the log (never the plaintext).
        // eslint-disable-next-line no-console
        console.warn(
          err instanceof GroupStateConflict
            ? 'send: another tab is active for this conversation — reload to continue'
            : 'send failed',
          convId,
          err instanceof Error ? err.message : err,
        );
      }
    })();
  };

  const handleSend = (content: string, files?: File[]): void => {
    if (!selectedId) return;
    const convId = selectedId;
    // Live conversations: encrypt + send for real over the network. Requires a non-empty text body (live
    // attachments aren't wired yet) and the sealing deps; otherwise no-op rather than a false send signal.
    if (isLive(convId)) {
      const group = liveGroups.current.get(convId);
      if (group && messagingDeps && content.trim()) sendLive(convId, group, messagingDeps, content);
      return;
    }
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
      // Demo/seed conversations: run a REAL MLS encrypt→decrypt round-trip before marking the message sent —
      // the recovered plaintext confirms the E2EE path and a lock shows. A failure marks the bubble failed,
      // never sent (no false delivery signal); `encrypted` stays false so no lock shows.
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
