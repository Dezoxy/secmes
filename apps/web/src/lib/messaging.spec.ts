import { MlsEngine, importUnlockKey, type Conversation, type DeviceKeys } from '@argus/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the transport; the crypto (encrypt/decrypt) and the keystore (real sealed IndexedDB) are real.
vi.mock('./api', () => ({ sendMessage: vi.fn(), fetchMessages: vi.fn() }));
import { fetchMessages, sendMessage, type FetchedMessage } from './api';
import { fromBase64, toBase64 } from './base64';
import { DeviceKeystore, GroupStateConflict } from './keystore';
import { decodeEnvelope } from './message-envelope';
import {
  backfillConversation,
  receiveLiveMessage,
  sendLiveMessage,
  type MessagingDeps,
} from './messaging';

const send = vi.mocked(sendMessage);
const fetch = vi.mocked(fetchMessages);

/** A real 1:1: returns the self (alice) + peer (bob) conversations over a shared group. */
async function pair(
  engine: MlsEngine,
): Promise<{ alice: DeviceKeys; aliceConv: Conversation; bobConv: Conversation }> {
  const alice = await engine.generateDeviceKeys('alice');
  const bob = await engine.generateDeviceKeys('bob');
  const aliceConv = await engine.createConversation('c1', alice);
  const bobConv = await engine.joinConversation(bob, await aliceConv.addMember(bob.publicPackage));
  return { alice, aliceConv, bobConv };
}

function fetched(id: string, senderUserId: string, ciphertext: string): FetchedMessage {
  return {
    id,
    senderUserId,
    clientMessageId: `cmid-${id}`,
    ciphertext,
    alg: 'MLS_1.0',
    epoch: 0,
    attachmentObjectKey: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('sendLiveMessage', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    send.mockReset();
    fetch.mockReset();
  });

  it('encrypts, persists the advanced state, then POSTs decryptable ciphertext', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv, bobConv } = await pair(engine);
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };
    send.mockResolvedValue({ messageId: 'm1', createdAt: 't', deduplicated: false });

    const sent = await sendLiveMessage(deps, 'c1', aliceConv, 'hello bob');

    expect(sent.serverId).toBe('m1');
    expect(send).toHaveBeenCalledTimes(1);
    const [convId, body] = send.mock.calls[0]!;
    expect(convId).toBe('c1');
    expect(body.alg).toBe('MLS_1.0');
    expect(typeof body.clientMessageId).toBe('string');
    // The wire we POSTed is REAL ciphertext — the peer decrypts + decodes it to the message (proves E2EE).
    expect(decodeEnvelope(await bobConv.decrypt(fromBase64(body.ciphertext)))).toEqual({
      kind: 'app',
      text: 'hello bob',
      attachments: [],
    });
    // The advanced ratchet was persisted: a reload continues the SAME ratchet (peer decrypts its next msg).
    const reloaded = (await ks.loadConversations(alice, key)).get('c1');
    expect(reloaded).toBeDefined();
    expect(await bobConv.decrypt(await reloaded!.encrypt('again'))).toBe('again');
  });

  it('always wraps in the envelope — refs ride E2E, and envelope-shaped user text stays unambiguous', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv, bobConv } = await pair(engine);
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };
    send.mockResolvedValue({ messageId: 'm1', createdAt: 't', deduplicated: false });

    const ref = {
      objectKey: 'tenant/obj',
      key: 'a2V5',
      iv: 'aXY',
      name: 'photo.png',
      mime: 'image/png',
      size: 4096,
    };
    await sendLiveMessage(deps, 'c1', aliceConv, 'look', [ref]);
    // The peer decrypts the wire → the JSON envelope carries the content key/iv (E2E), never the server.
    const withAtt = await bobConv.decrypt(fromBase64(send.mock.calls[0]![1].ciphertext));
    expect(decodeEnvelope(withAtt)).toEqual({ kind: 'app', text: 'look', attachments: [ref] });

    // Text-only is ALSO wrapped (so the wire is unambiguous); the peer decodes it back to the text.
    await sendLiveMessage(deps, 'c1', aliceConv, 'just text');
    expect(
      decodeEnvelope(await bobConv.decrypt(fromBase64(send.mock.calls[1]![1].ciphertext))),
    ).toEqual({
      kind: 'app',
      text: 'just text',
      attachments: [],
    });

    // A user typing envelope-shaped JSON is NOT mis-parsed — it's wrapped, so it decodes to the literal text.
    const tricky = '{"v":1,"text":"edited","attachments":[]}';
    await sendLiveMessage(deps, 'c1', aliceConv, tricky);
    expect(
      decodeEnvelope(await bobConv.decrypt(fromBase64(send.mock.calls[2]![1].ciphertext))),
    ).toEqual({
      kind: 'app',
      text: tricky,
      attachments: [],
    });
  });

  it('persists the advanced state BEFORE the POST (a failed POST still leaves it saved)', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv } = await pair(engine);
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };
    send.mockRejectedValue(new Error('network'));

    await expect(sendLiveMessage(deps, 'c1', aliceConv, 'hi')).rejects.toThrow('network');
    // persist precedes send, so the state is saved even though the POST failed (no re-encrypt → nonce reuse).
    expect((await ks.loadConversations(alice, key)).has('c1')).toBe(true);
  });

  it('aborts the POST when persistence conflicts (a stale cross-tab instance)', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv } = await pair(engine);
    // A keystore whose save reports another tab got there first — the send must NOT transmit.
    const ks = {
      saveConversationState: vi.fn().mockRejectedValue(new GroupStateConflict('c1')),
    } as unknown as DeviceKeystore;
    // The fake keystore never touches the key — a raw AES-GCM key satisfies the deps shape.
    const sessionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const deps: MessagingDeps = { keystore: ks, device: alice, sessionKey };

    await expect(sendLiveMessage(deps, 'c1', aliceConv, 'hi')).rejects.toBeInstanceOf(
      GroupStateConflict,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('backfillConversation', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    send.mockReset();
    fetch.mockReset();
  });

  it('decrypts peer messages in order, skips own, persists, and advances the cursor', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv, bobConv } = await pair(engine);
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };

    const b1 = toBase64(await bobConv.encrypt('hi from bob'));
    const own = toBase64(await aliceConv.encrypt('my own')); // alice can't re-derive this — must be skipped
    const b2 = toBase64(await bobConv.encrypt('second from bob'));
    fetch.mockResolvedValueOnce({
      messages: [
        fetched('m1', 'bob-user', b1),
        fetched('m2', 'alice-user', own),
        fetched('m3', 'bob-user', b2),
      ],
      nextCursor: null,
    });

    const result = await backfillConversation(deps, 'c1', aliceConv, 'alice-user');

    expect(result.messages.map((m) => m.text)).toEqual(['hi from bob', 'second from bob']);
    expect(result.messages.map((m) => m.serverId)).toEqual(['m1', 'm3']);
    expect(result.cursor).toBe('m3'); // advanced past the skipped own message too
    // The advanced receive state was persisted (a reload still decrypts bob's NEXT message).
    const reloaded = (await ks.loadConversations(alice, key)).get('c1');
    expect(await reloaded!.decrypt(await bobConv.encrypt('third'))).toBe('third');
  });

  it('resumes from the `after` cursor and skips an undecryptable message without failing the batch', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv, bobConv } = await pair(engine);
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };

    const good = toBase64(await bobConv.encrypt('decryptable'));
    const garbage = toBase64(new Uint8Array([1, 2, 3, 4, 5])); // not a valid MLS message
    fetch.mockResolvedValueOnce({
      messages: [fetched('m10', 'bob-user', garbage), fetched('m11', 'bob-user', good)],
      nextCursor: null,
    });

    const result = await backfillConversation(deps, 'c1', aliceConv, 'alice-user', 'm9');

    expect(fetch).toHaveBeenCalledWith('c1', { after: 'm9', limit: 100 });
    expect(result.messages.map((m) => m.text)).toEqual(['decryptable']); // garbage skipped, batch survives
    expect(result.cursor).toBe('m11');
  });

  it('does not persist when nothing decrypted (only own/empty)', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv } = await pair(engine);
    const own = toBase64(await aliceConv.encrypt('mine'));
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const saveSpy = vi.spyOn(ks, 'saveConversationState');
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };
    fetch.mockResolvedValueOnce({
      messages: [fetched('m1', 'alice-user', own)],
      nextCursor: null,
    });

    const result = await backfillConversation(deps, 'c1', aliceConv, 'alice-user');

    expect(result.messages).toHaveLength(0);
    expect(result.cursor).toBe('m1'); // cursor still advances past the skipped own message
    expect(saveSpy).not.toHaveBeenCalled(); // nothing advanced → no seal
  });
});

describe('receiveLiveMessage', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    send.mockReset();
    fetch.mockReset();
  });

  it('decrypts a peer push, persists, and returns it', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv, bobConv } = await pair(engine);
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };

    const ct = toBase64(await bobConv.encrypt('live!'));
    const got = await receiveLiveMessage(
      deps,
      'c1',
      aliceConv,
      fetched('m1', 'bob-user', ct),
      'alice-user',
    );

    expect(got?.text).toBe('live!');
    expect(got?.serverId).toBe('m1');
    // Persisted: a reload continues the SAME ratchet (decrypts bob's next message).
    const reloaded = (await ks.loadConversations(alice, key)).get('c1');
    expect(await reloaded!.decrypt(await bobConv.encrypt('next'))).toBe('next');
  });

  it('returns null for our OWN message (already echoed locally) — no decrypt, no persist', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv } = await pair(engine);
    const own = toBase64(await aliceConv.encrypt('mine'));
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const saveSpy = vi.spyOn(ks, 'saveConversationState');
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };

    const got = await receiveLiveMessage(
      deps,
      'c1',
      aliceConv,
      fetched('m1', 'alice-user', own),
      'alice-user',
    );

    expect(got).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('returns null for an undecryptable push without persisting (no throw)', async () => {
    const engine = await MlsEngine.create();
    const { alice, aliceConv } = await pair(engine);
    const ks = await DeviceKeystore.open(engine);
    const key = await importUnlockKey(new Uint8Array(32).fill(1));
    const saveSpy = vi.spyOn(ks, 'saveConversationState');
    const deps: MessagingDeps = {
      keystore: ks,
      device: alice,
      sessionKey: key,
    };

    const got = await receiveLiveMessage(
      deps,
      'c1',
      aliceConv,
      fetched('m1', 'bob-user', toBase64(new Uint8Array([9, 9, 9, 9]))),
      'alice-user',
    );

    expect(got).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
