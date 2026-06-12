// Live 1:1 conversations (Slice 3, initiator side; persistence wired in Slice 5). Replaces the loopback
// `mls.ts` demo for real peers: claim a peer's KeyPackage from the directory → verify the safety number
// out-of-band (#20) → MLS `addMember` → create the conversation → deliver the sealed Welcome → PERSIST the
// group state. The persist runs only AFTER delivery succeeds, so a reload before the first send recovers the
// conversation, yet a delivery failure leaves no durable phantom. Recipient join is Slice 4; live send/fetch
// is Slice 5 (lib/messaging).

import {
  MlsEngine,
  deserializeKeyPackage,
  safetyNumber,
  serializeInvite,
  type Conversation,
  type DeviceKeys,
  type KeyPackage,
} from '@argus/crypto';

import {
  CommitEpochConflictError,
  claimAllKeyPackages,
  claimKeyPackage,
  createConversation,
  deliverWelcome,
  postCommit,
  type ClaimedKeyPackage,
} from './api';
import { toBase64 } from './base64';
import type { DeviceKeystore, StoredMessage } from './keystore';
import { conversationLock, withLock } from './locks';
import { sendLiveMessage, type MessagingDeps } from './messaging';

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
    /** The per-unlock session key — seals the persisted group state (cheap AES-GCM). Memory only. */
    private readonly sessionKey: CryptoKey,
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
    await deliverWelcome(conversationId, {
      recipientUserId: pending.peer.userId,
      recipientDeviceId: pending.peer.deviceId,
      ...serializeInvite(invite),
    });
    // Persist the group state only AFTER delivery SUCCEEDS — the durable state must exist before `confirm()`
    // returns (so a reload before the first send recovers it), but NOT on a delivery failure: persisting
    // first would leave a phantom conversation (rehydrated on next unlock) whose peer was never added
    // server-side, so its sends would go nowhere. `deliverWelcome` doesn't touch the local MLS state
    // (`addMember` already advanced it), so this persists the same post-add state, just gated on delivery.
    await this.keystore.saveConversationState(
      this.device,
      conversationId,
      conversation,
      this.sessionKey,
    );
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

// ── Group conversation manager (B1) ──────────────────────────────────────────────────────────────────
// Two-phase, safety-number-gated flow for creating and extending MLS group conversations.
// Same security model as ConversationManager: prepare() only claims packages and derives safety numbers;
// confirm() does the crypto + server operations, and is unreachable until the caller has shown safety
// numbers to the user. Each claimed package is a separate KeyPackage (per-device) and an identity-bound
// MLS add adds every device in a single commit, so all devices of a new member join together.

/** Per-device data claimed for a group member in Phase 1. */
export interface PendingGroupMember {
  userId: string;
  /** All devices that have packages available (one entry per device). */
  allDevices: ClaimedKeyPackage[];
  /**
   * Per-device safety numbers — one per entry in `allDevices`. Each must be verified before confirming.
   * Verifying only the first device is insufficient for multi-device members: a swapped key on any
   * device is a MITM, and only per-device verification catches it.
   */
  safetyNumbers: string[];
  /** Deserialized KeyPackages for all devices — held for Phase 2 add. */
  keyPackages: KeyPackage[];
}

/** Phase-1 result for a group create or add — pending safety-number confirmation. */
export interface PendingGroup {
  members: PendingGroupMember[];
  groupName: string;
}

/** A successfully created or extended group conversation. */
export interface GroupConversationSession {
  conversationId: string;
  conversation: Conversation;
  groupName: string;
  /** The confirmed member user ids added in this operation (for UI naming). */
  addedUserIds: string[];
}

/**
 * Two-phase, safety-number-gated manager for MLS group conversations.
 *
 * `prepare(memberUserIds, groupName)` — claims packages from the key directory for all listed members,
 * computes safety numbers (one per user, derived from their primary device's published signature key).
 * Returns a `PendingGroup` with all material needed for Phase 2.
 *
 * `confirmCreate(pending)` — ONLY call after the user has confirmed every safety number in `pending.members`.
 * Builds the MLS group locally, stages a commit adding all members, posts it to the server, delivers
 * Welcomes, and sends an in-stream encrypted group-meta message carrying the group name.
 *
 * `confirmAdd(conversationId, conversation, pending, deps)` — same but for an existing conversation.
 * Stages and posts an add commit for the new members.
 */
export class GroupConversationManager {
  private enginePromise: Promise<MlsEngine> | null = null;

  constructor(
    private readonly device: DeviceKeys,
    private readonly selfUserId: string,
    private readonly keystore: DeviceKeystore,
    private readonly sessionKey: CryptoKey,
  ) {}

  private engine(): Promise<MlsEngine> {
    this.enginePromise ??= MlsEngine.create();
    return this.enginePromise;
  }

  /** Phase 1: claim packages for all `memberUserIds` and derive safety numbers. Trusts nothing yet. */
  async prepare(memberUserIds: string[], groupName: string): Promise<PendingGroup> {
    const members: PendingGroupMember[] = [];
    for (const userId of memberUserIds) {
      const claimed = await claimAllKeyPackages(userId);
      if (claimed.length === 0) {
        throw new Error(`user ${userId} has no key packages available — ask them to sign in first`);
      }
      // B1 assumes one device per user — `claimAllKeyPackages` returns that one package (or 0 if
      // exhausted). Multi-device (B2) will need a device-count endpoint to detect partial pools
      // where some devices have packages and others don't; those omitted devices would miss the
      // Welcome and be unable to join. That gap is out of scope for B1.
      const keyPackages = claimed.map((c) => deserializeKeyPackage(c.keyPackage));
      // One safety number per device — a swapped key on ANY device is a MITM; per-device SN is the
      // only way to catch it. The UI shows each one sequentially before confirm() is reachable.
      const safetyNumbers = await Promise.all(
        claimed.map((c) =>
          safetyNumber(this.device.publicPackage, deserializeKeyPackage(c.keyPackage)),
        ),
      );
      members.push({ userId, allDevices: claimed, safetyNumbers, keyPackages });
    }
    return { members, groupName };
  }

  /**
   * Phase 2 — create: ONLY after all safety numbers in `pending.members` are confirmed out-of-band.
   * Creates a solo server conversation, stages a commit adding all member devices, wins the epoch-0 slot,
   * and sends an in-stream encrypted group-meta message with the group name.
   */
  async confirmCreate(
    pending: PendingGroup,
    deps: MessagingDeps,
  ): Promise<GroupConversationSession> {
    const engine = await this.engine();
    const conversation = await engine.createConversation(crypto.randomUUID(), this.device);

    const allPackages = pending.members.flatMap((m) => m.keyPackages);
    const staged = await conversation.stageMembershipCommit({ add: allPackages });
    if (!staged.invite)
      throw new Error('group commit produced no Welcome — check that members have packages');

    const inv = serializeInvite(staged.invite);
    const { conversationId } = await createConversation([this.selfUserId]);

    const welcomes = pending.members.flatMap((m) =>
      m.allDevices.map((d) => ({
        recipientUserId: m.userId,
        recipientDeviceId: d.deviceId,
        welcome: inv.welcome,
        ratchetTree: inv.ratchetTree,
      })),
    );

    // Hold the conversation lock for the full stage→post→apply→persist sequence so concurrent sends,
    // receives, or commit drains cannot interleave (same lock as sendLiveMessage/receiveLiveMessage/
    // drainCommits). sendLiveMessage acquires the same lock, so it is called AFTER this block to
    // avoid re-entrancy deadlock (Web Locks is non-reentrant per the spec).
    await withLock(conversationLock(conversationId), async () => {
      // Persist the pending post-commit state BEFORE the POST — if the tab crashes after a successful
      // POST but before applyStaged/saveConversationState, the drain path (onSubscribed → drainCommits)
      // re-syncs from the server on next load.
      const pendingBytes = conversation.serializeStaged(staged);
      await this.keystore.saveStagedCommit(
        this.device,
        conversationId,
        this.sessionKey,
        pendingBytes,
        staged.epoch,
      );
      pendingBytes.fill(0); // wipe the transient plaintext — the sealed copy is in IDB

      try {
        await postCommit(conversationId, {
          clientCommitId: crypto.randomUUID(),
          epoch: staged.epoch,
          commit: toBase64(staged.commit),
          welcomes,
          addedUserIds: pending.members.map((m) => m.userId),
          removedUserIds: [],
        });
      } catch (err) {
        conversation.discardStaged(staged);
        // Only clear the IDB pending slot on a definite 409 (another member won the epoch). For
        // ambiguous failures (network error, 5xx), the server may have committed — preserve the
        // pending slot so reload can detect and promote it if the commit landed.
        if (err instanceof CommitEpochConflictError) {
          await this.keystore.clearStagedCommit(conversationId);
        }
        throw err;
      }

      await conversation.applyStaged(staged);
      await this.keystore.saveConversationState(
        this.device,
        conversationId,
        conversation,
        this.sessionKey,
      );
      await this.keystore.clearStagedCommit(conversationId);
    });

    // Record this device as the creator so the "Add member" gate survives page reload.
    await this.keystore.saveGroupCreatorId(this.device, conversationId, this.selfUserId);

    if (pending.groupName) {
      // sendLiveMessage acquires the conversation lock itself — safe to call after the commit lock releases.
      const ack = await sendLiveMessage(
        deps,
        conversationId,
        conversation,
        pending.groupName,
        [],
        'group-meta',
      );
      // Persist the group-meta so the creator sees the group name on page reload.
      // (Backfill skips own messages, so without this the creator loses the name after a reload.)
      void this.keystore.appendMessages(this.device, conversationId, this.sessionKey, [
        {
          id: ack.serverId,
          senderId: this.selfUserId,
          content: pending.groupName,
          timestamp: ack.createdAt,
          status: 'read',
          encrypted: true,
          kind: 'group-meta',
        } satisfies StoredMessage,
      ]);
    }

    return {
      conversationId,
      conversation,
      groupName: pending.groupName,
      addedUserIds: pending.members.map((m) => m.userId),
    };
  }

  /**
   * Phase 2 — add member: ONLY after the safety numbers are confirmed. Stages a commit adding the new
   * members to `conversationId`, posts it, re-sends the group-meta to cover the new member's history.
   */
  async confirmAdd(
    conversationId: string,
    conversation: Conversation,
    pending: PendingGroup,
    deps: MessagingDeps,
  ): Promise<void> {
    const allPackages = pending.members.flatMap((m) => m.keyPackages);

    // Serialize the full stage→post→apply→persist sequence under the conversation lock so concurrent
    // sends, receives, or commit drains (all holding the same lock) cannot interleave. sendLiveMessage
    // acquires the same lock, so it is called AFTER this block to avoid re-entrancy deadlock.
    await withLock(conversationLock(conversationId), async () => {
      const staged = await conversation.stageMembershipCommit({ add: allPackages });
      if (!staged.invite)
        throw new Error('add commit produced no Welcome — member has no packages');

      const inv = serializeInvite(staged.invite);
      const welcomes = pending.members.flatMap((m) =>
        m.allDevices.map((d) => ({
          recipientUserId: m.userId,
          recipientDeviceId: d.deviceId,
          welcome: inv.welcome,
          ratchetTree: inv.ratchetTree,
        })),
      );

      const pendingBytes = conversation.serializeStaged(staged);
      await this.keystore.saveStagedCommit(
        this.device,
        conversationId,
        this.sessionKey,
        pendingBytes,
        staged.epoch,
      );
      pendingBytes.fill(0);

      try {
        await postCommit(conversationId, {
          clientCommitId: crypto.randomUUID(),
          epoch: staged.epoch,
          commit: toBase64(staged.commit),
          welcomes,
          addedUserIds: pending.members.map((m) => m.userId),
          removedUserIds: [],
        });
      } catch (err) {
        conversation.discardStaged(staged);
        // Only clear the IDB pending slot on a definite 409 (another member won the epoch). For
        // ambiguous failures (network error, 5xx), the server may have committed — preserve the
        // pending slot so reload can detect and promote it if the commit landed.
        if (err instanceof CommitEpochConflictError) {
          await this.keystore.clearStagedCommit(conversationId);
        }
        throw err;
      }

      await conversation.applyStaged(staged);
      await this.keystore.saveConversationState(
        this.device,
        conversationId,
        conversation,
        this.sessionKey,
      );
      await this.keystore.clearStagedCommit(conversationId);
    });

    // Re-send the group name so the new member can read it (they can't see pre-join history).
    // sendLiveMessage acquires the same conversation lock — called after the commit lock releases.
    if (pending.groupName) {
      await sendLiveMessage(
        deps,
        conversationId,
        conversation,
        pending.groupName,
        [],
        'group-meta',
      );
    }
  }
}
