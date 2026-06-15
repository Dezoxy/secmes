import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { BlobStore } from '../blob/blob-store.js';
import { schema, withTenant } from '../db/index.js';
import {
  ATTACHMENT_RETENTION_DAYS,
  MAX_ATTACHMENT_BYTES,
  type CreateUploadGrant,
} from './attachments.schemas.js';
import { requireMembership, requireUser } from './membership.js';

/** A minted upload capability — the presigned URL is short-lived and MUST never be logged or persisted. */
export interface UploadGrant {
  objectKey: string;
  uploadUrl: string;
}

/** A minted download capability — the presigned URL is short-lived and MUST never be logged or persisted. */
export interface DownloadGrant {
  url: string;
}

@Injectable()
export class AttachmentsService {
  constructor(private readonly blobStore: BlobStore) {}

  /**
   * Mint an UPLOAD grant for an encrypted attachment. In one RLS-scoped tx: resolve the verified caller,
   * require they're a member of `conversationId`, then create the attachments row (server-minted object key,
   * verified uploader, declared byteSize). The blob CIPHERTEXT is uploaded directly to the store via the
   * presigned URL — it never transits the API; the content key rides E2E in the MLS message, never here.
   */
  async createUploadGrant(auth: VerifiedAuth, body: CreateUploadGrant): Promise<UploadGrant> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth);
      await requireMembership(tx, body.conversationId, user);
      // Server-minted, tenant-prefixed (the table CHECK requires `object_key LIKE tenant_id || '/%'`).
      const objectKey = `${auth.tenantId}/${randomUUID()}`;
      await tx.insert(schema.attachments).values({
        tenantId: auth.tenantId,
        conversationId: body.conversationId,
        objectKey,
        byteSize: body.byteSize,
        uploadedBy: user, // VERIFIED caller — never client input
        // Lifecycle (checkpoint 37): the standalone cleanup worker reaps the blob + row after this instant.
        // Computed with the DB clock (now()), not the API host's, so retention is consistent.
        expiresAt: sql`now() + make_interval(days => ${ATTACHMENT_RETENTION_DAYS})`,
      });
      // Presign INSIDE the tx: if it throws (store unconfigured / temporarily broken) the row insert is
      // rolled back, so a failed grant leaves NO orphan metadata for an object that can't be uploaded
      // (Codex P2). presignPut makes no DB call — it signs the S3 URL locally (pure HMAC, no network).
      const uploadUrl = await this.blobStore.presignPut(objectKey);
      return { objectKey, uploadUrl };
    });
  }

  /**
   * Mint a DOWNLOAD grant. AUTHZ from the attachment ROW's `conversation_id` (server-verified, never a client
   * message ref) — the caller must be a member of the owning conversation, so a non-member can't get a URL
   * for a blob they shouldn't see (no IDOR). Same 404 for not-found / not-a-member / RLS-hidden.
   */
  async createDownloadGrant(auth: VerifiedAuth, objectKey: string): Promise<DownloadGrant> {
    await withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth);
      const [att] = await tx
        .select({ conversationId: schema.attachments.conversationId })
        .from(schema.attachments)
        // RLS already scopes this to the caller's tenant; the explicit tenant_id predicate is
        // defense-in-depth (invariant #3) so a future RLS misconfig fails at the query, not silently.
        // The expiry predicate enforces the retention boundary AT THE API: an attachment past its
        // expires_at is 404 the instant it lapses — independent of the cleanup worker, so a delayed or
        // down worker can't keep expired blobs reachable (Codex P2). (Null = never expires → still served;
        // post-A4 + the 0013 backfill there are no nulls, but fail-open for that edge.)
        .where(
          and(
            eq(schema.attachments.objectKey, objectKey),
            eq(schema.attachments.tenantId, auth.tenantId),
            or(isNull(schema.attachments.expiresAt), gt(schema.attachments.expiresAt, sql`now()`)),
          ),
        )
        .limit(1);
      if (!att) throw new NotFoundException('attachment not found');
      await requireMembership(tx, att.conversationId, user);
    });
    // Hard size-cap enforcement: an S3 presigned PUT can't bind Content-Length, so verify the ACTUAL size and
    // refuse to serve a blob over the cap (an oversized upload is reclaimed by the lifecycle worker, #37).
    // Size is metadata — the server never reads the ciphertext.
    const size = await this.blobStore.blobSize(objectKey);
    if (size !== null && size > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('attachment exceeds the size limit');
    }
    const url = await this.blobStore.presignGet(objectKey);
    return { url };
  }
}
