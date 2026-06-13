import {
  MlsEngine,
  deserializeInvite,
  deviceSignaturePublicKeyB64,
  serializeKeyPackage,
  type Argon2Params,
  type DeviceKeys,
} from '@argus/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the directory/server calls; the crypto + the keystore (real sealed IndexedDB) are real.
vi.mock('./api', () => ({
  claimKeyPackage: vi.fn(),
  claimAllKeyPackages: vi.fn(),
  listEnrollments: vi.fn().mockResolvedValue([]),
  createConversation: vi.fn(),
  deliverWelcome: vi.fn(),
  postCommit: vi.fn(),
  CommitEpochConflictError: class CommitEpochConflictError extends Error {},
}));
import {
  claimKeyPackage,
  claimAllKeyPackages,
  listEnrollments,
  createConversation,
  deliverWelcome,
  postCommit,
} from './api';
import { ConversationManager } from './conversations';
import { DeviceKeystore } from './keystore';

const claim = vi.mocked(claimKeyPackage);
const claimAll = vi.mocked(claimAllKeyPackages);
const create = vi.mocked(createConversation);
const deliver = vi.mocked(deliverWelcome);
const post = vi.mocked(postCommit);
const FAST: Argon2Params = { m: 8192, t: 2, p: 1 };

describe('ConversationManager', () => {
  let engine: MlsEngine;
  let me: DeviceKeys;
  let peer: DeviceKeys;
  let keystore: DeviceKeystore;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory(); // fresh sealed group-state store per test
    engine = await MlsEngine.create();
    me = await engine.generateDeviceKeys('me');
    peer = await engine.generateDeviceKeys('peer');
    keystore = await DeviceKeystore.open(engine, FAST);
    claim.mockReset();
    claimAll.mockReset();
    create.mockReset();
    deliver.mockReset();
    post.mockReset();
    // The directory hands back the peer's PUBLIC KeyPackage (what a real claim returns).
    claim.mockResolvedValue({
      deviceId: 'peer-device',
      signaturePublicKey: deviceSignaturePublicKeyB64(peer),
      keyPackage: serializeKeyPackage(peer.publicPackage),
    });
    // Default: no own other devices (single-device path).
    claimAll.mockResolvedValue([]);
    create.mockResolvedValue({ conversationId: 'conv-1' });
    deliver.mockResolvedValue({ welcomeId: 'welcome-1' });
    post.mockResolvedValue({ id: 'commit-1', epoch: 1, deduplicated: false });
  });

  it('prepare() claims + derives the safety number but creates NOTHING server-side (the #20 gate)', async () => {
    const mgr = new ConversationManager(
      me,
      'me-user',
      keystore,
      await keystore.deriveSessionKey('pw'),
    );
    const pending = await mgr.prepare('peer-user');

    expect(claim).toHaveBeenCalledWith('peer-user');
    expect(pending.peer).toEqual({
      userId: 'peer-user',
      deviceId: 'peer-device',
      signaturePublicKey: deviceSignaturePublicKeyB64(peer),
    });
    expect(pending.safetyNumber).toMatch(/\d/);
    // The MITM defense: no conversation exists and no Welcome is sent until the user confirms the number.
    expect(create).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('confirm() creates the conversation and delivers a Welcome the peer can actually join', async () => {
    const mgr = new ConversationManager(
      me,
      'me-user',
      keystore,
      await keystore.deriveSessionKey('pw'),
    );
    const pending = await mgr.prepare('peer-user');
    const session = await mgr.confirm(pending);

    // Creates a SOLO conversation (just the caller); the peer is added atomically by deliverWelcome.
    expect(create).toHaveBeenCalledWith(['me-user']);
    expect(session.conversationId).toBe('conv-1');
    expect(mgr.get('conv-1')).toBe(session);

    // The Welcome is pinned to the claimed device…
    expect(deliver).toHaveBeenCalledTimes(1);
    const [convId, body] = deliver.mock.calls[0]!;
    expect(convId).toBe('conv-1');
    expect(body.recipientUserId).toBe('peer-user');
    expect(body.recipientDeviceId).toBe('peer-device');

    // …and is genuinely joinable: the peer joins from the delivered material and decrypts our message.
    const peerConversation = await engine.joinConversation(
      peer,
      deserializeInvite({ welcome: body.welcome, ratchetTree: body.ratchetTree }),
    );
    const SECRET = 'first live message';
    expect(await peerConversation.decrypt(await session.conversation.encrypt(SECRET))).toBe(SECRET);
  });

  it('confirm() persists only AFTER the Welcome is delivered, and durably (recover on reload-before-send)', async () => {
    // Not yet persisted while delivery is in flight (so a delivery failure leaves no phantom)…
    let persistedDuringDeliver: boolean | null = null;
    deliver.mockImplementation(async () => {
      persistedDuringDeliver = await keystore.hasConversationState(me, 'conv-1');
      return { welcomeId: 'welcome-1' };
    });
    const mgr = new ConversationManager(
      me,
      'me-user',
      keystore,
      await keystore.deriveSessionKey('pw'),
    );
    await mgr.confirm(await mgr.prepare('peer-user'));

    expect(persistedDuringDeliver).toBe(false);
    // …but durable by the time confirm() resolves, before any send.
    expect(await keystore.hasConversationState(me, 'conv-1')).toBe(true);

    // A reopened keystore rehydrates the started conversation; it continues the SAME ratchet the peer joined
    // — proving the initiator could recover it on reload even though it never sent a message.
    const body = deliver.mock.calls[0]![1];
    const peerConversation = await engine.joinConversation(
      peer,
      deserializeInvite({ welcome: body.welcome, ratchetTree: body.ratchetTree }),
    );
    const reopened = await DeviceKeystore.open(engine, FAST);
    const restored = (
      await reopened.loadConversations(me, 'pw', await reopened.deriveSessionKey('pw'))
    ).get('conv-1');
    if (!restored) throw new Error('expected the started conversation to be persisted');
    expect(await peerConversation.decrypt(await restored.encrypt('after reload'))).toBe(
      'after reload',
    );
  });

  it('confirm() persists NOTHING when Welcome delivery fails (no rehydrated phantom conversation)', async () => {
    deliver.mockRejectedValue(new Error('delivery 500'));
    const mgr = new ConversationManager(
      me,
      'me-user',
      keystore,
      await keystore.deriveSessionKey('pw'),
    );

    await expect(mgr.confirm(await mgr.prepare('peer-user'))).rejects.toThrow();

    // No durable state → the next unlock won't rehydrate a phantom "New contact" whose peer was never added.
    expect(await keystore.hasConversationState(me, 'conv-1')).toBe(false);
    expect(
      (await keystore.loadConversations(me, 'pw', await keystore.deriveSessionKey('pw'))).size,
    ).toBe(0);
  });

  describe('B2 multi-device self-add', () => {
    let d2: DeviceKeys;

    beforeEach(async () => {
      d2 = await engine.generateDeviceKeys('me:d2-uuid');
      // Simulate own D2 in the key directory for self-user only; peer-user has no secondary devices.
      // Using mockImplementation so confirm()'s two claimAll calls are distinguished by userId.
      claimAll.mockImplementation(async (userId: string) =>
        userId === 'me-user'
          ? [
              {
                deviceId: 'd2-server-id',
                signaturePublicKey: deviceSignaturePublicKeyB64(d2),
                keyPackage: serializeKeyPackage(d2.publicPackage),
              },
            ]
          : [],
      );
      // D2 has completed the enrollment trust flow — must be in the approved list for self-add.
      // fingerprint must match deviceSignaturePublicKeyB64(d2) so the leaf-key MITM check passes.
      vi.mocked(listEnrollments).mockResolvedValue([
        { requestingDeviceId: 'd2-server-id', fingerprint: deviceSignaturePublicKeyB64(d2) },
      ] as never);
    });

    it('confirm() uses postCommit to batch-add peer + own other device when selfDeviceId is provided', async () => {
      const mgr = new ConversationManager(
        me,
        'me-user',
        keystore,
        await keystore.deriveSessionKey('pw'),
        'my-server-id', // selfDeviceId — causes claimAllKeyPackages to run
      );
      const session = await mgr.confirm(await mgr.prepare('peer-user'));

      // claimAllKeyPackages called for self-user, deliverWelcome NOT used (multi-device path uses postCommit).
      expect(claimAll).toHaveBeenCalledWith('me-user');
      expect(deliver).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(1);

      const [convId, body] = post.mock.calls[0]!;
      expect(convId).toBe('conv-1');
      // Peer receives a Welcome.
      expect(body.welcomes).toContainEqual(
        expect.objectContaining({ recipientUserId: 'peer-user', recipientDeviceId: 'peer-device' }),
      );
      // Own D2 also receives a Welcome.
      expect(body.welcomes).toContainEqual(
        expect.objectContaining({ recipientUserId: 'me-user', recipientDeviceId: 'd2-server-id' }),
      );
      // Only the peer is added to conversation_members (self is already a member).
      expect(body.addedUserIds).toEqual(['peer-user']);

      // The conversation session is still returned correctly.
      expect(session.conversationId).toBe('conv-1');
    });

    it('confirm() peer can join from the multi-device Welcome', async () => {
      const mgr = new ConversationManager(
        me,
        'me-user',
        keystore,
        await keystore.deriveSessionKey('pw'),
        'my-server-id',
      );
      await mgr.confirm(await mgr.prepare('peer-user'));

      const body = post.mock.calls[0]![1];
      const peerWelcome = body.welcomes.find((w) => w.recipientUserId === 'peer-user')!;

      const peerConversation = await engine.joinConversation(
        peer,
        deserializeInvite({ welcome: peerWelcome.welcome, ratchetTree: peerWelcome.ratchetTree }),
      );
      const session = mgr.get('conv-1')!;
      const SECRET = 'hello from multi-device epoch';
      expect(await peerConversation.decrypt(await session.conversation.encrypt(SECRET))).toBe(
        SECRET,
      );
    });

    it('confirm() falls back to single-device path when selfDeviceId is null', async () => {
      const mgr = new ConversationManager(
        me,
        'me-user',
        keystore,
        await keystore.deriveSessionKey('pw'),
        // selfDeviceId omitted → single-device path
      );
      await mgr.confirm(await mgr.prepare('peer-user'));

      // Single-device path: deliverWelcome used, postCommit not used, claimAllKeyPackages not called.
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
      expect(claimAll).not.toHaveBeenCalled();
    });
  });
});
