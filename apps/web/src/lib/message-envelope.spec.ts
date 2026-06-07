import { describe, expect, it } from 'vitest';

import { decodeEnvelope, encodeEnvelope, type AttachmentRef } from './message-envelope';

const ref: AttachmentRef = {
  objectKey: 'tenant/abc',
  key: 'a2V5', // opaque test placeholder (not a real key)
  iv: 'aXY',
  name: 'photo.png',
  mime: 'image/png',
  size: 4096,
};

describe('message envelope', () => {
  it('round-trips text + attachments', () => {
    const env = { text: 'look at this', attachments: [ref] };
    expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it('round-trips a text-only message', () => {
    expect(decodeEnvelope(encodeEnvelope({ text: 'hi', attachments: [] }))).toEqual({
      text: 'hi',
      attachments: [],
    });
  });

  it('back-compat: a bare-string (old) message decodes as plain text', () => {
    expect(decodeEnvelope('hello world')).toEqual({ text: 'hello world', attachments: [] });
  });

  it('back-compat: non-envelope JSON is treated as raw text, not parsed', () => {
    // A user literally typing JSON, or an old numeric/array payload — keep the raw string as the text.
    expect(decodeEnvelope('42')).toEqual({ text: '42', attachments: [] });
    expect(decodeEnvelope('{"foo":1}')).toEqual({ text: '{"foo":1}', attachments: [] });
    expect(decodeEnvelope('[1,2,3]')).toEqual({ text: '[1,2,3]', attachments: [] });
  });

  it('drops malformed attachment entries rather than throwing', () => {
    const wire = JSON.stringify({
      v: 1,
      text: 'mixed',
      attachments: [ref, { objectKey: 'x' }, null, 'nope'],
    });
    expect(decodeEnvelope(wire)).toEqual({ text: 'mixed', attachments: [ref] });
  });

  it('never leaks the content key into the server-bound message id space (sanity: key only in the body)', () => {
    const wire = encodeEnvelope({ text: 't', attachments: [ref] });
    // The encoded plaintext (which gets MLS-encrypted) is the ONLY place the key appears.
    expect(wire).toContain(ref.key);
  });
});
