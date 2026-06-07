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
  createConversation: vi.fn(),
  deliverWelcome: vi.fn(),
}));
import { claimKeyPackage, createConversation, deliverWelcome } from './api';
import { ConversationManager } from './conversations';
import { DeviceKeystore } from './keystore';

const claim = vi.mocked(claimKeyPackage);
const create = vi.mocked(createConversation);
const deliver = vi.mocked(deliverWelcome);
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
    create.mockReset();
    deliver.mockReset();
    // The directory hands back the peer's PUBLIC KeyPackage (what a real claim returns).
    claim.mockResolvedValue({
      deviceId: 'peer-device',
      signaturePublicKey: deviceSignaturePublicKeyB64(peer),
      keyPackage: serializeKeyPackage(peer.publicPackage),
    });
    create.mockResolvedValue({ conversationId: 'conv-1' });
    deliver.mockResolvedValue({ welcomeId: 'welcome-1' });
  });

  it('prepare() claims + derives the safety number but creates NOTHING server-side (the #20 gate)', async () => {
    const mgr = new ConversationManager(me, 'me-user', keystore, 'pw');
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
    const mgr = new ConversationManager(me, 'me-user', keystore, 'pw');
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

  it('confirm() persists the group state BEFORE delivering the Welcome (no loss on reload-before-send)', async () => {
    // At the moment the peer is told (deliverWelcome), the initiator's state must already be durable.
    deliver.mockImplementation(async () => {
      expect(await keystore.hasConversationState(me, 'conv-1')).toBe(true);
      return { welcomeId: 'welcome-1' };
    });
    const mgr = new ConversationManager(me, 'me-user', keystore, 'pw');
    await mgr.confirm(await mgr.prepare('peer-user'));

    // A reopened keystore rehydrates the started conversation; it continues the SAME ratchet the peer joined
    // — proving the initiator could recover it on reload even though it never sent a message.
    const body = deliver.mock.calls[0]![1];
    const peerConversation = await engine.joinConversation(
      peer,
      deserializeInvite({ welcome: body.welcome, ratchetTree: body.ratchetTree }),
    );
    const reopened = await DeviceKeystore.open(engine, FAST);
    const restored = (await reopened.loadConversations(me, 'pw')).get('conv-1');
    if (!restored) throw new Error('expected the started conversation to be persisted');
    expect(await peerConversation.decrypt(await restored.encrypt('after reload'))).toBe(
      'after reload',
    );
  });
});
