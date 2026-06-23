// Real MLS (RFC 9420) end-to-end encryption in the browser, over the ONLY crypto module (@argus/crypto).
// This proves the encrypt → opaque-wire-bytes → decrypt path works in the browser — the de-risking that
// gates a live client. For now BOTH devices live in this browser (you + a local peer): it is a genuine
// MLS round-trip, not a fake. The LIVE multi-user flow swaps the local peer for a remote member joined
// via the key directory + a server-delivered Welcome, and additionally needs auth (passkey session) +
// out-of-band fingerprint verification (#20, MITM defense) — none of which exist yet.

import { MlsEngine, safetyNumber, type Conversation } from '@argus/crypto';

let enginePromise: Promise<MlsEngine> | null = null;
function getEngine(): Promise<MlsEngine> {
  enginePromise ??= MlsEngine.create();
  return enginePromise;
}

/** Base64 of the opaque MLS wire bytes — exactly what would be stored/sent as `ciphertext` (server-blind). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface EncryptResult {
  /** Plaintext recovered by the RECEIVING device — equal to the input iff the round-trip succeeded. */
  plaintext: string;
  /** Base64 of the opaque MLS ciphertext that crosses the wire. */
  ciphertextB64: string;
}

export interface E2eeSession {
  /** MLS-encrypt as you, MLS-decrypt as the peer. Returns the recovered plaintext + the wire ciphertext. */
  send(text: string): Promise<EncryptResult>;
  /**
   * The out-of-band SAFETY NUMBER for this 2-party session (you ↔ peer), derived from both devices'
   * identity keys (@argus/crypto). Users compare it out-of-band to detect a MITM key-swap (#20). In the
   * loopback demo it's computed for the local peer; the live flow uses the remote peer's published key.
   */
  safetyNumber: string;
}

/** Create a fresh two-party MLS session (you + a local peer) in one group. */
export async function createE2eeSession(conversationId: string): Promise<E2eeSession> {
  const engine = await getEngine();
  const you = await engine.generateDeviceKeys(`you:${conversationId}`);
  const peer = await engine.generateDeviceKeys(`peer:${conversationId}`);
  const yourConversation: Conversation = await engine.createConversation(conversationId, you);
  // 2-party: addMember applies the commit locally AND yields the Welcome the peer joins with.
  const invite = await yourConversation.addMember(peer.publicPackage);
  const peerConversation: Conversation = await engine.joinConversation(peer, invite);
  // The number both sides would compare out-of-band to confirm no key was swapped (MITM, #20).
  // Derived from PUBLIC KeyPackages — in the live flow the peer's comes from the key directory.
  const sn = await safetyNumber(you.publicPackage, peer.publicPackage);
  return {
    safetyNumber: sn,
    async send(text: string): Promise<EncryptResult> {
      const wire = await yourConversation.encrypt(text); // opaque bytes — all that leaves the device
      const plaintext = await peerConversation.decrypt(wire); // the peer recovers it
      return { plaintext, ciphertextB64: toBase64(wire) };
    },
  };
}

const sessionsByConversation = new Map<string, Promise<E2eeSession>>();
/**
 * A lazily-created, cached MLS session PER conversation — so each peer is its own group with its own
 * keys, and therefore its own distinct safety number (#20). Stable per page load.
 */
export function getMlsSession(conversationId: string): Promise<E2eeSession> {
  let session = sessionsByConversation.get(conversationId);
  if (!session) {
    session = createE2eeSession(conversationId);
    sessionsByConversation.set(conversationId, session);
  }
  return session;
}

/** Self-test for a UI badge: a real round-trip succeeds AND the plaintext never appears in the wire bytes. */
export async function verifyE2ee(): Promise<boolean> {
  const probe = 'argus-e2ee-probe';
  const session = await createE2eeSession('selftest');
  const { plaintext, ciphertextB64 } = await session.send(probe);
  return plaintext === probe && !atob(ciphertextB64).includes(probe);
}
