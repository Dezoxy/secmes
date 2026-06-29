// MLS-encrypted call signaling channel.
// Outbound: Omit<CallSignal,...> → add metadata → Conversation.encrypt → CallEnvelope → WS.
// Inbound:  CallEnvelope frame → Conversation.decryptAuthenticated → sender-bind → CallSignal → dispatch.
//
// SECURITY invariants:
// - SDP/ICE only ever leave the device as MLS ciphertext (invariant 1: server stays crypto-blind).
// - Sender is authenticated via MLS group signature; a decrypted signal without a verified sender is
//   rejected (fail-closed: every throw path in decryptAuthenticated propagates here as onError).
// - Replay guard: per-sender msgSeq high-water; a reused or out-of-order seq is silently dropped.
// - Loopback guard: sender identity == local identity → silently dropped.
// - Cross-call guard: signal.callId != this.callId → silently dropped.

import type { CallSignal } from '@argus/contracts';
import { CallSignalSchema } from '@argus/contracts';
import type { Conversation } from '@argus/crypto';
import { fromBase64, toBase64 } from './base64';
import type { IncomingCallSignalFrame, MessageSocket } from './ws';

/** Wire algorithm tag — must match the server's CipherEnvelopeSchema `alg` field. */
const WIRE_ALG = 'MLS_1.0';

export type { IncomingCallSignalFrame };

export interface CallSignalingOptions {
  conversation: Conversation;
  /** The local device's MLS identity string (`formatDeviceIdentity(userId, deviceUuid)`). */
  localIdentity: string;
  callId: string;
  conversationId: string;
  socket: MessageSocket;
  onSignal: (signal: CallSignal) => void;
  onError?: (err: Error) => void;
  /**
   * Called after `conversation.encrypt()` and BEFORE the ciphertext is sent.
   * Must persist the advanced ratchet state to durable storage (same contract as chat messaging)
   * so a crash/reload cannot reuse an already-consumed MLS generation.
   * Leave unset only in tests.
   */
  saveState?: () => Promise<void>;
}

export interface CallSignaling {
  /**
   * Encrypt a call signal and fire-and-forget it over the WebSocket.
   * `callId`, `msgSeq`, `nonce`, and `sentAt` are added automatically.
   */
  send(payload: Omit<CallSignal, 'callId' | 'msgSeq' | 'nonce' | 'sentAt'>): Promise<void>;
  /**
   * Decrypt and authenticate an inbound signal frame from the gateway.
   * Silently drops loopback, replays, cross-call, invalid MLS, and invalid signal shapes.
   */
  receiveFrame(frame: IncomingCallSignalFrame): Promise<void>;
}

/** 24 CSPRNG bytes → base64url (no padding). 24 bytes → exactly 32 chars, no `=`. */
function mintNonce(): string {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

export function createCallSignaling(opts: CallSignalingOptions): CallSignaling {
  const {
    conversation,
    localIdentity,
    callId,
    conversationId,
    socket,
    onSignal,
    onError,
    saveState,
  } = opts;
  let outSeq = 0;
  // Per-sender high-water mark: msgSeq values already seen from that sender.
  // A frame is dropped if its msgSeq <= the stored high-water.
  const inSeqHW = new Map<string, number>();

  return {
    async send(payload) {
      const seq = outSeq;
      outSeq += 1;
      const signal: CallSignal = {
        ...payload,
        callId,
        msgSeq: seq,
        nonce: mintNonce(),
        // performance.now() as integer ms: monotonic, avoids leaking the wall-clock.
        sentAt: Math.round(performance.now()),
      } as CallSignal;

      // Validate the assembled signal before encrypting (catches a bad payload shape early).
      CallSignalSchema.parse(signal);

      const wire = await conversation.encrypt(JSON.stringify(signal));
      // Persist the advanced ratchet BEFORE the ciphertext leaves the device (crash/nonce-reuse guard).
      await saveState?.();
      const ciphertext = toBase64(wire);
      const epoch = conversation.epoch;
      socket.sendCallSignal({
        callId,
        conversationId,
        msgSeq: seq,
        envelope: { ciphertext, alg: WIRE_ALG, epoch },
      });
    },

    async receiveFrame(frame) {
      // Replay guard — check BEFORE decrypting (decrypt advances the MLS ratchet, so we must
      // decide replay before consuming the generation).
      const hw = inSeqHW.get(frame.senderUserId);
      if (hw !== undefined && frame.msgSeq <= hw) return; // replay or reorder — drop silently

      // Outer callId fast-reject: drop frames obviously destined for a different call BEFORE
      // decrypting, to avoid wasting a ratchet generation. The authenticated inner callId check
      // below is the authoritative guard — this is defence-in-depth using the unverified outer field.
      if (frame.callId !== callId) return;

      let plaintext: string;
      let senderIdentity: string;
      try {
        const wire = fromBase64(frame.envelope.ciphertext);
        ({ plaintext, senderIdentity } = await conversation.decryptAuthenticated(wire));
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      // Loopback guard: should not happen in V1 (server echoes only to the peer), but fail-closed.
      if (senderIdentity === localIdentity) return;

      // Sender binding: the outer `frame.senderUserId` (unverified) must match the MLS-authenticated
      // `senderIdentity` (format "userId:deviceUuid"). Without this, a malicious relay could spoof
      // a different userId in the outer header, polluting or blocking the replay-guard HW map.
      if (!senderIdentity.startsWith(`${frame.senderUserId}:`)) {
        onError?.(new Error('call signal sender binding failed'));
        return;
      }

      // Advance the high-water AFTER successful decryption so a failed decrypt doesn't lock out
      // a valid retransmit of the same seq (though the ratchet already advanced — a retransmit
      // would fail decryption anyway, making this ordering moot but consistent).
      inSeqHW.set(frame.senderUserId, frame.msgSeq);

      let parsed: ReturnType<typeof CallSignalSchema.safeParse>;
      try {
        parsed = CallSignalSchema.safeParse(JSON.parse(plaintext));
      } catch {
        onError?.(new Error('call signal plaintext is not valid JSON'));
        return;
      }

      if (!parsed.success) {
        onError?.(new Error('call signal failed schema validation'));
        return;
      }

      // Cross-call guard: the server routes by callId but a mis-delivered frame shouldn't be acted on.
      if (parsed.data.callId !== callId) return;

      onSignal(parsed.data);
    },
  };
}
