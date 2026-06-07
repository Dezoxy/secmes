// The PLAINTEXT structure that gets MLS-encrypted inside each message. The server NEVER sees this — it lives
// inside the ciphertext. It carries the message text plus per-attachment refs INCLUDING the content key + IV;
// those ride end-to-end and MUST never reach the server (they're how a recipient decrypts the blob).
//
// Wire form is a versioned JSON object. Back-compat: a decrypted plaintext that ISN'T a v1 envelope (an older
// bare-string message, or any non-envelope JSON) is treated as plain text with no attachments.

/** A reference to one encrypted attachment, carried E2E inside the message envelope. */
export interface AttachmentRef {
  /** Server-minted blob handle (from the upload grant). Opaque; used to request a download grant. */
  objectKey: string;
  /** base64 raw AES-256-GCM content key — E2E ONLY, never sent to the server. */
  key: string;
  /** base64 12-byte AES-GCM IV. */
  iv: string;
  /** Original filename (display + download). */
  name: string;
  /** Content type (client-side rendering only — never a server column). */
  mime: string;
  /** Plaintext byte size (display). */
  size: number;
}

/** A decoded message: the text plus any attachment refs. */
export interface MessageEnvelope {
  text: string;
  attachments: AttachmentRef[];
}

const ENVELOPE_VERSION = 1;

/** Serialize an envelope to the plaintext string that gets MLS-encrypted. */
export function encodeEnvelope(env: MessageEnvelope): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, text: env.text, attachments: env.attachments });
}

/**
 * Parse a decrypted plaintext into an envelope. Back-compat: anything that isn't a recognizable v1 envelope
 * (an old bare-string message, or non-envelope JSON) is returned as plain text with no attachments.
 * Malformed attachment entries are dropped rather than throwing — a bad ref shouldn't sink the whole message.
 */
export function decodeEnvelope(plaintext: string): MessageEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { text: plaintext, attachments: [] }; // not JSON → old plain-text message
  }
  if (!isV1Envelope(parsed)) {
    return { text: plaintext, attachments: [] }; // JSON, but not our envelope → treat the raw string as text
  }
  return { text: parsed.text, attachments: parsed.attachments.filter(isAttachmentRef) };
}

function isV1Envelope(x: unknown): x is { v: number; text: string; attachments: unknown[] } {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.v === ENVELOPE_VERSION && typeof o.text === 'string' && Array.isArray(o.attachments);
}

function isAttachmentRef(x: unknown): x is AttachmentRef {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.objectKey === 'string' &&
    typeof r.key === 'string' &&
    typeof r.iv === 'string' &&
    typeof r.name === 'string' &&
    typeof r.mime === 'string' &&
    typeof r.size === 'number'
  );
}
