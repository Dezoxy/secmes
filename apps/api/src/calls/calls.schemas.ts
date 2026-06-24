import { z } from 'zod';

// Server-local mirror of the VoIP call contracts. Local for now (the two-worlds split — see
// messaging.schemas.ts); migrate to the shared @argus/contracts package when the web client lands.
// `.strict()` rejects unknown keys (fail-closed) on every inbound shape.
//
// SCOPE: only the schemas the SERVER actually validates — the OUTER routing envelope (WS) and the
// REST request/response shapes. The inner `CallSignal` (SDP / ICE / signal type) is E2EE and rides
// inside `envelope.ciphertext`; the server is crypto-blind to it and never parses it (invariant 1),
// so it is deliberately absent here.

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

// A call is identified by a server-minted UUID; clients never invent it (the gateway drops any
// callId absent from the live call-authorization map).
export const CallIdSchema = z.string().uuid();

// Per-call monotonic ordering/replay counter, scoped to (callId, sender); starts at 0.
export const MsgSeqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// The opaque MLS envelope wrapping the encrypted CallSignal. The server forwards `ciphertext`
// verbatim and never parses it (mirrors the messaging envelope bounds).
const CallCipherEnvelopeSchema = z
  .object({
    ciphertext: base64.min(1).max(65536), // opaque MLS blob — never parsed server-side
    alg: z.string().min(1).max(64), // AEAD/version tag, e.g. "MLS_1.0"
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), // MLS epoch
  })
  .strict();

// What the CLIENT sends INTO the gateway on `call.signal`. The server validates THIS (routing
// metadata + opaque envelope) — never the inner signal. `callId`/`msgSeq` are cleartext opaque ids
// used only to route and to enforce a per-(callId, sender) replay window without decrypting.
export const CallEnvelopeSchema = z
  .object({
    conversationId: z.string().uuid(),
    callId: CallIdSchema,
    msgSeq: MsgSeqSchema,
    envelope: CallCipherEnvelopeSchema,
  })
  .strict();
export type CallEnvelope = z.infer<typeof CallEnvelopeSchema>;

// ── REST: POST /calls/turn-credentials ──
export const TurnCredentialsRequestSchema = z.object({}).strict();
export type TurnCredentialsRequest = z.infer<typeof TurnCredentialsRequestSchema>;

export const IceServerSchema = z.object({
  urls: z.array(z.string().min(1)).min(1),
  username: z.string().min(1).optional(), // "<expiry>:<sub>" — present for TURN, absent for STUN
  credential: z.string().min(1).optional(), // SECRET-equivalent (HMAC); never log or cache
});
export type IceServer = z.infer<typeof IceServerSchema>;

export const TurnCredentialsResponseSchema = z.object({
  iceServers: z.array(IceServerSchema).min(1),
  iceTransportPolicy: z.enum(['relay', 'all']), // 'relay' in V1 → forces TURN, hides peer IP
  ttlSeconds: z.number().int().positive(),
});
export type TurnCredentialsResponse = z.infer<typeof TurnCredentialsResponseSchema>;

// ── REST: POST /calls/:friendUserId/invite ──
export const CreateCallRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    media: z.literal('audio'), // V1 audio-only; widens to z.enum(['audio','video']) in V1.1
  })
  .strict();
export type CreateCallRequest = z.infer<typeof CreateCallRequestSchema>;

export const CreateCallResponseSchema = z.object({ callId: z.string().uuid() }).strict();
export type CreateCallResponse = z.infer<typeof CreateCallResponseSchema>;

// ── REST: GET/PUT /calls/settings (relay-only preference) ──
// API field is camelCase `relayOnly`; the backing DB column is `users.call_relay_only` (P0-SET).
export const CallSettingsResponseSchema = z.object({
  relayOnly: z.boolean(),
});
export type CallSettingsResponse = z.infer<typeof CallSettingsResponseSchema>;

export const UpdateCallSettingsRequestSchema = z.object({ relayOnly: z.boolean() }).strict();
export type UpdateCallSettingsRequest = z.infer<typeof UpdateCallSettingsRequestSchema>;
