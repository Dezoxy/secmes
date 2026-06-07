// Live 1:1 conversations (Slice 3, initiator side; persistence wired in Slice 5). Replaces the loopback
// `mls.ts` demo for real peers: claim a peer's KeyPackage from the directory → verify the safety number
// out-of-band (#20) → MLS `addMember` → create the conversation → PERSIST the group state → deliver the
// sealed Welcome. The persist precedes delivery so a reload before the first send can't lose a conversation
// the peer has already joined. The recipient's join is Slice 4; live send/fetch is Slice 5 (lib/messaging).

import {
  MlsEngine,
  deserializeKeyPackage,
  safetyNumber,
  serializeInvite,
  type Conversation,
  type DeviceKeys,
  type KeyPackage,
} from '@argus/crypto';

import { claimKeyPackage, createConversation, deliverWelcome } from './api';
import type { DeviceKeystore } from './keystore';

/** The peer device a conversation is being started with — ids + the signature key (no private material). */
export interface PeerRef {
  userId: string;
  /** The device whose KeyPackage was claimed — pins where the Welcome must be delivered. */
  deviceId: string;
  signaturePublicKey: string;
}

/** Phase-1 result: a claimed peer KeyPackage + its safety number, awaiting out-of-band (#20) confirmation. */
export interface PendingConversation {
  peer: PeerRef;
  /** The claimed package — UNTRUSTED until `safetyNumber` is verified out-of-band. Held for phase 2 only. */
  peerKeyPackage: KeyPackage;
  /** The #20 safety number the user must confirm out-of-band BEFORE `confirm()`. */
  safetyNumber: string;
}

/** A live conversation session: the in-memory MLS group + the peer it was verified against. */
export interface ConversationSession {
  conversationId: string;
  conversation: Conversation;
  peer: PeerRef;
  safetyNumber: string;
}

/**
 * Two-phase, safety-number-gated manager for starting 1:1 conversations. The split is a SECURITY control,
 * not ergonomics: `prepare()` only claims the peer's KeyPackage and derives the #20 safety number — it
 * never trusts the package. `confirm()` — which performs `addMember` and delivers the Welcome — takes
 * `prepare()`'s result as its input, so it is unreachable until the caller has shown the safety number and
 * the user confirmed it out-of-band. `addMember` cannot verify the package belongs to the intended peer
 * (a malicious server could swap keys — MITM); the OOB check is the only defense, so the API makes adding
 * before verifying impossible.
 */
export class ConversationManager {
  private readonly sessions = new Map<string, ConversationSession>();
  private enginePromise: Promise<MlsEngine> | null = null;

  constructor(
    private readonly device: DeviceKeys,
    /** The signed-in user's id — used to create a SOLO conversation (see `confirm`). */
    private readonly selfUserId: string,
    /** The sealed keystore — persists the new group state before the peer can join (see `confirm`). */
    private readonly keystore: DeviceKeystore,
    /** The session passphrase — seals the persisted group state. In memory only; never logged/transmitted. */
    private readonly passphrase: string,
  ) {}

  private engine(): Promise<MlsEngine> {
    this.enginePromise ??= MlsEngine.create();
    return this.enginePromise;
  }

  /** Phase 1: claim the peer's one-time KeyPackage and derive the safety number. Trusts nothing yet. */
  async prepare(peerUserId: string): Promise<PendingConversation> {
    const claimed = await claimKeyPackage(peerUserId);
    const peerKeyPackage = deserializeKeyPackage(claimed.keyPackage);
    // safetyNumber is over the STABLE signature keys (#20) — a swapped package shifts it, exposing a MITM.
    const sn = await safetyNumber(this.device.publicPackage, peerKeyPackage);
    return {
      peer: {
        userId: peerUserId,
        deviceId: claimed.deviceId,
        signaturePublicKey: claimed.signaturePublicKey,
      },
      peerKeyPackage,
      safetyNumber: sn,
    };
  }

  /**
   * Phase 2: call ONLY after the user has confirmed `pending.safetyNumber` out-of-band. Builds the MLS
   * group, adds the now-trusted peer, creates the server conversation, and delivers the sealed Welcome.
   * Local crypto runs FIRST so a malformed package fails before any server state is created (no orphans).
   */
  async confirm(pending: PendingConversation): Promise<ConversationSession> {
    const engine = await this.engine();
    // The MLS group id is internal (random, CSPRNG); the server assigns the routing/conversation id. Build
    // the group + Welcome locally before touching the server so a bad package can't orphan a conversation.
    const conversation = await engine.createConversation(crypto.randomUUID(), this.device);
    const invite = await conversation.addMember(pending.peerKeyPackage); // trust granted by the #20 gate
    // Create a SOLO conversation (just me — my own id dedups to the creator server-side), then let
    // deliverWelcome add the peer in the SAME transaction that stores the Welcome. So if delivery fails,
    // the peer is never left a member of a conversation with no Welcome — no peer-visible / undecryptable
    // orphan and no duplicate-on-retry for the peer; only a benign empty self-conversation remains.
    const { conversationId } = await createConversation([this.selfUserId]);
    // Persist the group state BEFORE delivering the Welcome: once the peer can join, the initiator's state
    // must already be durable, or a reload after delivery but before the first send would lose the
    // conversation (and its ratchet) while the peer has already joined it.
    await this.keystore.saveConversationState(
      this.device,
      conversationId,
      conversation,
      this.passphrase,
    );
    await deliverWelcome(conversationId, {
      recipientUserId: pending.peer.userId,
      recipientDeviceId: pending.peer.deviceId,
      ...serializeInvite(invite),
    });
    const session: ConversationSession = {
      conversationId,
      conversation,
      peer: pending.peer,
      safetyNumber: pending.safetyNumber,
    };
    this.sessions.set(conversationId, session);
    return session;
  }

  /** The live session for a conversation started this page load (in-memory cache; the durable copy is sealed
   * on `confirm` and reloaded on unlock via the keystore). */
  get(conversationId: string): ConversationSession | undefined {
    return this.sessions.get(conversationId);
  }
}
