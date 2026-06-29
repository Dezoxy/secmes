import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, X } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/IconButton';
import { modalBackdropEnterMotion, modalPanelEnterMotion } from '../ui/motion';
import { useChatContext } from '../chat/ChatContext';
import { dicebearAvatar } from '../../lib/dicebear';

function useElapsedSeconds(startedAt: number | null): string {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((performance.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallOverlay() {
  const { callPhase, micMuted, friends, acceptCall, declineCall, hangUp, toggleMic } =
    useChatContext();
  const acceptedRef = useRef(false);

  if (callPhase.type === 'idle') return null;

  const callerName =
    callPhase.type === 'ringing'
      ? (friends.find((f) => f.userId === callPhase.callerUserId)?.displayName ??
        callPhase.callerUserId)
      : callPhase.type === 'calling'
        ? (friends.find((f) => f.userId === callPhase.peerUserId)?.displayName ??
          callPhase.peerUserId)
        : null;

  const callerUserId =
    callPhase.type === 'ringing'
      ? callPhase.callerUserId
      : callPhase.type === 'calling'
        ? callPhase.peerUserId
        : callPhase.type === 'negotiating' || callPhase.type === 'active'
          ? null
          : null;

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-center justify-center ${modalBackdropEnterMotion}`}
    >
      {/* Backdrop — not rendered for active (bottom strip only) */}
      {callPhase.type !== 'active' && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
      )}

      {/* ── Ringing ── */}
      {callPhase.type === 'ringing' && (
        <div
          className={`relative z-10 flex flex-col items-center gap-6 rounded-3xl border border-white/5 bg-[#12121a] px-10 py-10 shadow-2xl ${modalPanelEnterMotion}`}
        >
          <Avatar
            name={callerName ?? ''}
            src={callerUserId ? dicebearAvatar(callerUserId) : undefined}
            size="xl"
            shape="circle"
          />
          <div className="text-center">
            <p className="text-lg font-semibold">{callerName}</p>
            <p className="mt-1 text-sm text-white/50">Incoming voice call</p>
          </div>
          <div className="flex gap-8">
            <button
              onClick={() => {
                if (acceptedRef.current) return;
                acceptedRef.current = true;
                void acceptCall().catch(() => {
                  acceptedRef.current = false;
                });
              }}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500 shadow-lg transition-opacity hover:opacity-90 active:scale-95"
              aria-label="Accept call"
            >
              <Phone className="h-7 w-7" />
            </button>
            <button
              onClick={declineCall}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 shadow-lg transition-opacity hover:opacity-90 active:scale-95"
              aria-label="Decline call"
            >
              <PhoneOff className="h-7 w-7" />
            </button>
          </div>
        </div>
      )}

      {/* ── Calling (outbound, waiting for peer) ── */}
      {callPhase.type === 'calling' && (
        <div
          className={`relative z-10 flex flex-col items-center gap-6 rounded-3xl border border-white/5 bg-[#12121a] px-10 py-10 shadow-2xl ${modalPanelEnterMotion}`}
        >
          <Avatar
            name={callerName ?? ''}
            src={callerUserId ? dicebearAvatar(callerUserId) : undefined}
            size="xl"
            shape="circle"
          />
          <div className="text-center">
            <p className="text-lg font-semibold">{callerName}</p>
            <p className="mt-1 text-sm text-white/50">Calling…</p>
          </div>
          <button
            onClick={hangUp}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 shadow-lg transition-opacity hover:opacity-90 active:scale-95"
            aria-label="Cancel call"
          >
            <X className="h-7 w-7" />
          </button>
        </div>
      )}

      {/* ── Negotiating (connecting) ── */}
      {callPhase.type === 'negotiating' && (
        <div
          className={`relative z-10 flex flex-col items-center gap-4 rounded-3xl border border-white/5 bg-[#12121a] px-10 py-10 shadow-2xl ${modalPanelEnterMotion}`}
        >
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <p className="text-sm text-white/60">Connecting…</p>
          <button
            onClick={hangUp}
            className="mt-2 flex h-12 w-12 items-center justify-center rounded-full bg-red-500 shadow-lg transition-opacity hover:opacity-90"
            aria-label="Cancel call"
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* ── Active — bottom-docked strip ── */}
      {callPhase.type === 'active' && (
        <ActiveStrip
          conversationId={callPhase.conversationId}
          startedAt={callPhase.startedAt}
          micMuted={micMuted}
          onToggleMic={toggleMic}
          onHangUp={hangUp}
          friends={friends}
        />
      )}

      {/* ── Ended ── */}
      {callPhase.type === 'ended' && (
        <div
          className={`relative z-10 rounded-2xl border border-white/5 bg-[#12121a] px-6 py-4 shadow-2xl ${modalPanelEnterMotion}`}
        >
          <p className="text-sm text-white/70">Call ended</p>
        </div>
      )}
    </div>
  );
}

function ActiveStrip({
  conversationId,
  startedAt,
  micMuted,
  onToggleMic,
  onHangUp,
  friends,
}: {
  conversationId: string;
  startedAt: number;
  micMuted: boolean;
  onToggleMic: () => void;
  onHangUp: () => void;
  friends: ReturnType<typeof useChatContext>['friends'];
}) {
  const { convToPeerId } = useChatContext();
  const peerUserId = convToPeerId.get(conversationId);
  const peerName =
    friends.find((f) => f.userId === peerUserId)?.displayName ?? peerUserId ?? 'Peer';
  const elapsed = useElapsedSeconds(startedAt);

  return (
    <div className="absolute bottom-20 left-1/2 z-10 flex -translate-x-1/2 items-center gap-4 rounded-2xl border border-white/10 bg-[#12121a]/95 px-5 py-3 shadow-2xl backdrop-blur-xl">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{peerName}</p>
        <p className="text-xs tabular-nums text-white/50">{elapsed}</p>
      </div>
      <IconButton
        onClick={onToggleMic}
        size="md"
        className={`rounded-xl ${micMuted ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}
        aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {micMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </IconButton>
      <button
        onClick={onHangUp}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500 transition-opacity hover:opacity-90"
        aria-label="Hang up"
      >
        <PhoneOff className="h-4 w-4" />
      </button>
    </div>
  );
}
