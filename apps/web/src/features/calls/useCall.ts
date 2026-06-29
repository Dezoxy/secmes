// Call state machine hook.
// Owns the full lifecycle: idle → ringing/calling → negotiating → active → ended → idle.
//
// SECURITY invariants:
// - TURN credentials are ephemeral: fetched once per call, passed directly to createPeerConnection,
//   never cached in state, never logged.
// - SDP/ICE travel as MLS ciphertext (via createCallSignaling). The server is crypto-blind to call content.
// - iceTransportPolicy:'relay' is enforced by the server-returned TurnConfig — never overridden here.
// - Ratchet state is persisted (saveGroupState) after every encrypt/decrypt — matches the messaging path.
// - All signal parsing and sender-binding checks are handled inside createCallSignaling.receiveFrame().

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import type { CallSignal } from '@argus/contracts';
import { inviteToCall } from '../../lib/api';
import { createCallSignaling } from '../../lib/call-signaling';
import { getAudioStream } from '../../lib/media-devices';
import { createPeerConnection, type ArgusPC } from '../../lib/peer-connection';
import { loadTurnConfig } from '../../lib/turn-credentials';
import type {
  IncomingCallEnd,
  IncomingCallRing,
  IncomingCallSignalFrame,
  MessageSocket,
} from '../../lib/ws';
import type { CallSignaling } from '../../lib/call-signaling';

export type CallPhase =
  | { type: 'idle' }
  | { type: 'ringing'; callId: string; conversationId: string; callerUserId: string }
  | { type: 'calling'; callId: string; conversationId: string; peerUserId: string }
  | { type: 'negotiating'; callId: string; conversationId: string }
  | { type: 'active'; callId: string; conversationId: string; startedAt: number }
  | { type: 'ended'; reason: string };

export interface UseCallOptions {
  /** Stable MessageSocket shim that always proxies to the live socket. */
  socket: MessageSocket;
  /** Live MLS groups, keyed by conversationId. Needed for conversation.encrypt/decrypt. */
  liveGroups: React.MutableRefObject<Map<string, MlsGroup>>;
  /** Local MLS identity string: "${userId}:${deviceId}". Null before device is provisioned. */
  localIdentity: string | null;
  /** Persist ratchet state for a conversation after encrypt/decrypt — same path as messaging. */
  saveGroupState: (conversationId: string) => Promise<void>;
  /** Maps conversationId → peerUserId. Used to resolve peer name on incoming ring. */
  convToPeerId: Map<string, string>;
}

export interface UseCallResult {
  callPhase: CallPhase;
  micMuted: boolean;
  /** WS callback — wire into useLiveConversations. */
  onCallRing: (event: IncomingCallRing) => void;
  /** WS callback — wire into useLiveConversations. */
  onCallSignalFrame: (frame: IncomingCallSignalFrame) => void;
  /** WS callback — wire into useLiveConversations. */
  onCallEnd: (event: IncomingCallEnd) => void;
  startCall: (conversationId: string, peerUserId: string) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  hangUp: () => void;
  toggleMic: () => void;
}

export function useCall(opts: UseCallOptions): UseCallResult {
  const { socket, liveGroups, localIdentity, saveGroupState } = opts;

  const [callPhase, setCallPhase] = useState<CallPhase>({ type: 'idle' });
  const [micMuted, setMicMuted] = useState(false);

  // Live call refs — recreated per call, torn down on hangup/end.
  const pcRef = useRef<ArgusPC | null>(null);
  const sigRef = useRef<CallSignaling | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Pending ring metadata — stored when phase becomes 'ringing', consumed by acceptCall.
  const ringRef = useRef<IncomingCallRing | null>(null);

  // Signal frames that arrive before sigRef is ready (race: ring arrives, acceptCall sets up sig).
  const pendingFramesRef = useRef<IncomingCallSignalFrame[]>([]);

  // Timeout handle for 'ended' → 'idle' auto-dismiss.
  const endedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Generation counter: incremented by teardown so startCall can detect a hangup that fired
  // while setupCall was awaiting loadTurnConfig()/getAudioStream() (the async setup window).
  const callGenRef = useRef(0);

  const clearEndedTimer = useCallback(() => {
    if (endedTimerRef.current !== null) {
      clearTimeout(endedTimerRef.current);
      endedTimerRef.current = null;
    }
  }, []);

  // Shared teardown: close PC, stop stream, null refs, schedule idle.
  const teardown = useCallback(
    (reason: string) => {
      callGenRef.current++;
      clearEndedTimer();
      pcRef.current?.close();
      pcRef.current = null;
      sigRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (audioRef.current) {
        audioRef.current.srcObject = null;
      }
      pendingFramesRef.current = [];
      setMicMuted(false);
      setCallPhase({ type: 'ended', reason });
      endedTimerRef.current = setTimeout(() => {
        setCallPhase({ type: 'idle' });
        ringRef.current = null;
      }, 2000);
    },
    [clearEndedTimer],
  );

  // Cleanup on unmount.
  useEffect(
    () => () => {
      clearEndedTimer();
      pcRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioRef.current) audioRef.current.srcObject = null;
    },
    [clearEndedTimer],
  );

  // Initialise the audio element once (never rendered in DOM — just played).
  if (!audioRef.current) {
    audioRef.current = new Audio();
    audioRef.current.autoplay = true;
  }

  // Handle a fully-decrypted, authenticated CallSignal from the signaling channel.
  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      const pc = pcRef.current;
      const sig = sigRef.current;

      switch (signal.type) {
        case 'call.invite': {
          // Callee receives offer → create answer. Phase remains 'negotiating' until PC connects.
          if (!pc || !sig) return;
          const answer = await pc.acceptOffer(signal.sdp);
          await sig.send({ type: 'call.accept', sdp: answer });
          break;
        }
        case 'call.accept': {
          // Caller receives answer.
          if (!pc) return;
          await pc.acceptAnswer(signal.sdp);
          break;
        }
        case 'call.ice': {
          if (!pc) return;
          await pc.addIceCandidate(signal.candidate);
          break;
        }
        case 'call.decline':
        case 'call.cancel':
        case 'call.busy':
          teardown(signal.type);
          break;
        case 'call.hangup':
          teardown('hangup');
          break;
        default:
          break;
      }
    },
    [teardown],
  );

  // Build a peer connection and signaling channel for a given callId + conversationId.
  const setupCall = useCallback(
    async (callId: string, conversationId: string): Promise<boolean> => {
      const identity = localIdentity;
      if (!identity) return false;

      const conversation = liveGroups.current.get(conversationId);
      if (!conversation) return false;

      const [config, stream] = await Promise.all([loadTurnConfig(), getAudioStream()]);
      streamRef.current = stream;

      const pc = createPeerConnection(config, {
        onConnectionStateChange: (state) => {
          if (state === 'connected') {
            setCallPhase({ type: 'active', callId, conversationId, startedAt: performance.now() });
          } else if (state === 'failed' || state === 'disconnected') {
            teardown(state);
          }
        },
        onIceCandidate: (candidate) => {
          void sigRef.current?.send({ type: 'call.ice', candidate });
        },
        onRemoteTrack: (track) => {
          if (audioRef.current) {
            audioRef.current.srcObject = new MediaStream([track]);
            void audioRef.current.play().catch(() => {});
          }
        },
      });

      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }
      pcRef.current = pc;

      const sig = createCallSignaling({
        conversation,
        localIdentity: identity,
        callId,
        conversationId,
        socket,
        onSignal: (s) => {
          void handleSignal(s);
        },
        onError: (err) => {
          // Log only err.message — never err/err.stack/the frame; message is metadata-only
          // (epoch, leaf index, wire-format descriptor). No SDP/ICE/key material reaches the log.
          // eslint-disable-next-line no-console
          console.warn('call signal error', err.message);
        },
        saveState: () => saveGroupState(conversationId),
      });
      sigRef.current = sig;

      // Flush any frames that arrived before signaling was ready.
      const pending = pendingFramesRef.current.splice(0);
      for (const frame of pending) {
        await sig.receiveFrame(frame);
      }

      return true;
    },
    [handleSignal, liveGroups, localIdentity, saveGroupState, socket],
  );

  const startCall = useCallback(
    async (conversationId: string, peerUserId: string) => {
      clearEndedTimer();
      const gen = ++callGenRef.current;
      // Allocate a server-minted callId BEFORE creating the PC (need it for signaling).
      const { callId } = await inviteToCall(peerUserId, { conversationId, media: 'audio' });

      setCallPhase({ type: 'calling', callId, conversationId, peerUserId });

      const ok = await setupCall(callId, conversationId);
      if (!ok || callGenRef.current !== gen) {
        // Either setup failed or hangUp fired while awaiting TURN/media (gen mismatch).
        // Peer is already ringing — release server-side, clean up any partial PC.
        pcRef.current?.close();
        pcRef.current = null;
        sigRef.current = null;
        socket.sendCallRelease(callId);
        if (callGenRef.current === gen) teardown('setup-failed');
        return;
      }

      const offer = await pcRef.current!.createOffer();
      await sigRef.current!.send({
        type: 'call.invite',
        sdp: offer,
        media: { audio: true, video: false },
        relayOnly: true,
      });
    },
    [clearEndedTimer, setupCall, socket, teardown],
  );

  const acceptCall = useCallback(async () => {
    const ring = ringRef.current;
    if (!ring) return;
    const { callId, conversationId } = ring;
    setCallPhase({ type: 'negotiating', callId, conversationId });
    await setupCall(callId, conversationId);
    // The 'call.invite' signal will arrive via onCallSignalFrame and be routed through handleSignal.
  }, [setupCall]);

  const declineCall = useCallback(() => {
    const ring = ringRef.current;
    if (!ring) return;
    // sigRef is null on the ringing path (signaling set up only on acceptCall) — the decline signal
    // is silently skipped; sendCallRelease is the authoritative termination signal for the server.
    void sigRef.current?.send({ type: 'call.decline', reason: 'declined' });
    socket.sendCallRelease(ring.callId);
    teardown('declined');
  }, [socket, teardown]);

  const hangUp = useCallback(() => {
    const phase = callPhase;
    const callId =
      phase.type === 'calling' ||
      phase.type === 'negotiating' ||
      phase.type === 'active' ||
      phase.type === 'ringing'
        ? phase.callId
        : null;

    void sigRef.current?.send({ type: 'call.hangup', reason: 'hangup' });
    if (callId) socket.sendCallRelease(callId);
    teardown('hangup');
  }, [callPhase, socket, teardown]);

  const toggleMic = useCallback(() => {
    const tracks = streamRef.current?.getAudioTracks() ?? [];
    const next = !micMuted;
    for (const track of tracks) {
      track.enabled = !next;
    }
    setMicMuted(next);
  }, [micMuted]);

  // ── WS callbacks ─────────────────────────────────────────────────────────────────────────────

  const onCallRing = useCallback((event: IncomingCallRing) => {
    // Ignore rings when already in a call — caller will get 'busy' from the server-side timeout.
    setCallPhase((prev) => {
      if (prev.type !== 'idle') return prev;
      ringRef.current = event;
      return {
        type: 'ringing',
        callId: event.callId,
        conversationId: event.conversationId,
        callerUserId: event.callerUserId,
      };
    });
  }, []);

  const onCallSignalFrame = useCallback((frame: IncomingCallSignalFrame) => {
    const sig = sigRef.current;
    if (!sig) {
      // Signaling not yet set up (e.g., accept() still in progress) — buffer for flush.
      pendingFramesRef.current.push(frame);
      return;
    }
    void sig.receiveFrame(frame);
  }, []);

  const onCallEnd = useCallback(
    (event: IncomingCallEnd) => {
      // Server-initiated end (timeout / peer-gone) — no outbound hangup signal needed.
      const phase = callPhase;
      if (phase.type !== 'idle' && phase.type !== 'ended' && phase.callId === event.callId) {
        teardown(event.reason);
      }
    },
    [callPhase, teardown],
  );

  return {
    callPhase,
    micMuted,
    onCallRing,
    onCallSignalFrame,
    onCallEnd,
    startCall,
    acceptCall,
    declineCall,
    hangUp,
    toggleMic,
  };
}
