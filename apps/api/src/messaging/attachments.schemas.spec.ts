import { describe, expect, it } from 'vitest';

import {
  CreateDownloadGrantSchema,
  CreateUploadGrantSchema,
  MAX_ATTACHMENT_BYTES,
} from './attachments.schemas.js';

const uuid = '11111111-1111-4111-8111-111111111111'; // valid v4 UUID (version 4, variant 8)

describe('attachment schemas', () => {
  it('upload grant: accepts a valid body; rejects oversize / non-positive / extra keys', () => {
    expect(
      CreateUploadGrantSchema.safeParse({ conversationId: uuid, byteSize: 1024 }).success,
    ).toBe(true);
    expect(
      CreateUploadGrantSchema.safeParse({
        conversationId: uuid,
        byteSize: MAX_ATTACHMENT_BYTES + 1,
      }).success,
    ).toBe(false); // over the policy cap
    expect(CreateUploadGrantSchema.safeParse({ conversationId: uuid, byteSize: 0 }).success).toBe(
      false,
    );
    expect(
      CreateUploadGrantSchema.safeParse({ conversationId: uuid, byteSize: 10, extra: 'x' }).success,
    ).toBe(false); // .strict()
    expect(
      CreateUploadGrantSchema.safeParse({ conversationId: 'not-a-uuid', byteSize: 10 }).success,
    ).toBe(false);
  });

  it('download grant: accepts an object key; rejects a URL or an empty key', () => {
    expect(CreateDownloadGrantSchema.safeParse({ objectKey: `${uuid}/abc` }).success).toBe(true);
    expect(
      CreateDownloadGrantSchema.safeParse({ objectKey: 'https://blob.example/x' }).success,
    ).toBe(false); // must be an object key, not a URL
    expect(CreateDownloadGrantSchema.safeParse({ objectKey: '' }).success).toBe(false);
  });
});
