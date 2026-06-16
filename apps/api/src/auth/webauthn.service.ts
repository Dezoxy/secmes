// Server-auth infrastructure — see docs/threat-models/passkey-auth.md and
// docs/threat-models/registration-and-tenancy.md.
import { randomBytes, createHash } from 'node:crypto';

import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationExtensionsClientInputs,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { and, count, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import { schema, withRouting, withTenant, withTenantAndInvite } from '../db/index.js';
import { PaymentRequiredException } from '../common/http-exceptions.js';
import { generateArgusId, isArgusIdCollision } from '../users/argus-id.js';
import { generateHandle, isHandleCollision } from '../users/handle-words.js';
import type { MintedSession } from './session-token.service.js';
import { SessionTokenService } from './session-token.service.js';
import { AuditService } from '../audit/audit.service.js';

// Fixed single-tenant UUID — all Phase 2 passkey users live here.
// See docs/threat-models/registration-and-tenancy.md §T6.
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const MAX_ATTEMPTS = 5;

function sha256hex(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function challengeBytesFromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function expectedChallengeFromHex(hex: string): string {
  return isoBase64URL.fromBuffer(Buffer.from(hex, 'hex'));
}

@Injectable()
export class WebAuthnService {
  private readonly logger = new Logger(WebAuthnService.name);
  private readonly rpName: string;
  private readonly rpID: string;
  private readonly expectedOrigin: string;

  constructor(
    private readonly sessions: SessionTokenService,
    private readonly audit: AuditService,
  ) {
    this.rpName = process.env['WEBAUTHN_RP_NAME'] ?? 'argus';
    this.rpID = process.env['WEBAUTHN_RP_ID'] ?? 'localhost';
    this.expectedOrigin = process.env['FRONTEND_ORIGIN'] ?? 'http://localhost:5173';
  }

  /**
   * Redeem an admin-issued invite code — validate, generate argus_id, and create a
   * webauthn_challenges row for the upcoming registration ceremony. Does NOT consume the invite
   * or create the user (those happen atomically in verifyRegistration).
   */
  async redeemCode(code: string): Promise<{ ceremonyId: string }> {
    const tokenHash = sha256hex(Buffer.from(code));
    const INVALID = 'invalid or expired code';

    const invite = await withRouting(async (tx) => {
      await tx.execute(sql`select set_config('app.invite_token_hash', ${tokenHash}, true)`);
      return tx
        .select({
          id: schema.tenantInvites.id,
          tenantId: schema.tenantInvites.tenantId,
          expiresAt: schema.tenantInvites.expiresAt,
          acceptedAt: schema.tenantInvites.acceptedAt,
          revokedAt: schema.tenantInvites.revokedAt,
          inviteeEmail: schema.tenantInvites.inviteeEmail,
        })
        .from(schema.tenantInvites)
        .where(eq(schema.tenantInvites.tokenHash, tokenHash))
        .limit(1)
        .then((r) => r[0]);
    });

    if (!invite) throw new UnauthorizedException(INVALID);
    // Reject email-scoped invites: this path has no verified email, so a forwarded
    // or leaked code would let the wrong person register. Email-scoped invites must
    // go through the Zitadel OIDC flow where the email is verified by the IdP.
    if (invite.inviteeEmail !== null) throw new UnauthorizedException(INVALID);
    // Any valid admin-issued invite is accepted here — the user always lands in
    // DEFAULT_TENANT_ID regardless of which tenant issued the invite.  The old
    // tenantId === DEFAULT_TENANT_ID guard prevented admins on non-default tenants
    // from issuing passkey invites via POST /tenants/invites.
    if (invite.acceptedAt !== null) throw new UnauthorizedException(INVALID);
    if (invite.revokedAt !== null) throw new UnauthorizedException(INVALID);
    if (invite.expiresAt < new Date()) throw new UnauthorizedException(INVALID);

    // Generate argus_id once and persist it. The SAME value must flow through options → verify →
    // user insert — see docs/threat-models/registration-and-tenancy.md §T1.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const argusId = generateArgusId();
      const challengeBytes = randomBytes(32);
      const challengeHex = challengeBytes.toString('hex');

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      try {
        const [row] = await withRouting((tx) =>
          tx
            .insert(schema.webauthnChallenges)
            .values({
              challengeHash: challengeHex,
              purpose: 'register',
              argusId,
              inviteId: invite.id,
              expiresAt,
            })
            .returning({ ceremonyId: schema.webauthnChallenges.ceremonyId }),
        );
        if (!row) throw new Error('challenge insert returned no row');
        return { ceremonyId: row.ceremonyId };
      } catch (err) {
        if (isArgusIdCollision(err) && attempt < MAX_ATTEMPTS - 1) continue;
        throw err;
      }
    }
    throw new Error('argus_id exhausted after max attempts');
  }

  /** Return WebAuthn registration options for an active register ceremony. */
  async getRegistrationOptions(ceremonyId: string): Promise<object> {
    const row = await withRouting((tx) =>
      tx
        .select()
        .from(schema.webauthnChallenges)
        .where(
          and(
            eq(schema.webauthnChallenges.ceremonyId, ceremonyId),
            eq(schema.webauthnChallenges.purpose, 'register'),
            gt(schema.webauthnChallenges.expiresAt, new Date()),
          ),
        )
        .limit(1)
        .then((r) => r[0]),
    );

    if (!row?.argusId) throw new NotFoundException('ceremony not found or expired');

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: row.argusId,
      userID: isoUint8Array.fromUTF8String(row.argusId) as Uint8Array<ArrayBuffer>,
      challenge: challengeBytesFromHex(row.challengeHash) as Uint8Array<ArrayBuffer>,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestationType: 'none',
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    });

    return options;
  }

  /**
   * Verify the registration response and, in ONE atomic transaction:
   * - delete the challenge (delete-on-use)
   * - mark the invite consumed
   * - insert user + user_tenant_index + webauthn_credential
   * Then (post-commit) mint the first session.
   *
   * See docs/threat-models/registration-and-tenancy.md §T2.
   */
  async verifyRegistration(
    ceremonyId: string,
    response: RegistrationResponseJSON,
  ): Promise<MintedSession> {
    // Step A — delete challenge (webauthn_challenges has no RLS; withRouting is correct).
    // First committer wins; a replay finds no row.
    const [challenge] = await withRouting((tx) =>
      tx
        .delete(schema.webauthnChallenges)
        .where(
          and(
            eq(schema.webauthnChallenges.ceremonyId, ceremonyId),
            eq(schema.webauthnChallenges.purpose, 'register'),
            gt(schema.webauthnChallenges.expiresAt, new Date()),
          ),
        )
        .returning(),
    );
    if (!challenge?.argusId || !challenge.inviteId) {
      throw new UnauthorizedException('ceremony not found, expired, or already used');
    }

    // Step B — single atomic transaction: consume invite + verify WebAuthn + insert user/credential.
    // withTenantAndInvite sets BOTH app.tenant_id=DEFAULT_TENANT_ID and app.current_invite_id so
    // the tenant_invites_passkey_consume PERMISSIVE policy (migration 0036) exposes the invite row
    // regardless of which tenant originally issued it. Rollback on any failure (handle collision,
    // attestation failure, or member-limit) leaves the invite unconsumed — user retries from redeem.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const displayName = generateHandle();
      try {
        const result = await withTenantAndInvite(
          DEFAULT_TENANT_ID,
          challenge.inviteId,
          async (tx) => {
            // Consume invite — exposed by tenant_invites_passkey_consume PERMISSIVE policy.
            // Re-check expiry at consume time: the challenge window is 5 min but the invite
            // itself may expire within that window. Without this check a just-expired invite
            // could create a user (redeemCode enforces expiry at redeem, not at verify).
            const now = new Date();
            const [marked] = await tx
              .update(schema.tenantInvites)
              .set({ acceptedAt: now })
              .where(
                and(
                  eq(schema.tenantInvites.id, challenge.inviteId!),
                  isNull(schema.tenantInvites.acceptedAt),
                  isNull(schema.tenantInvites.revokedAt),
                  gt(schema.tenantInvites.expiresAt, now),
                ),
              )
              .returning({ id: schema.tenantInvites.id });
            if (!marked) throw new ConflictException('invite already used or expired');

            // Verify WebAuthn attestation.
            const verification = await verifyRegistrationResponse({
              response,
              expectedChallenge: expectedChallengeFromHex(challenge.challengeHash),
              expectedRPID: this.rpID,
              expectedOrigin: this.expectedOrigin,
              requireUserVerification: true,
            });
            if (!verification.verified || !verification.registrationInfo) {
              throw new UnauthorizedException('attestation verification failed');
            }

            const { credential, aaguid, credentialBackedUp } = verification.registrationInfo;
            const sub = `argusid:${challenge.argusId}`;

            // Race-safe member limit check: lock the tenant row so concurrent registrations
            // cannot both pass and overshoot the limit (mirrors acceptInvite in tenants.service.ts).
            const [tenantRow] = await tx
              .select({ memberLimit: schema.tenants.memberLimit })
              .from(schema.tenants)
              .where(eq(schema.tenants.id, DEFAULT_TENANT_ID))
              .for('update');
            if (tenantRow?.memberLimit !== null && tenantRow?.memberLimit !== undefined) {
              const [countRow] = await tx
                .select({ count: count() })
                .from(schema.users)
                .where(
                  and(
                    eq(schema.users.tenantId, DEFAULT_TENANT_ID),
                    eq(schema.users.status, 'active'),
                  ),
                );
              if ((countRow?.count ?? 0) >= tenantRow.memberLimit) {
                throw new PaymentRequiredException(
                  'This workspace has reached its member limit. Ask the workspace admin to upgrade.',
                );
              }
            }

            // Insert user (email=NULL — Phase 2 passkey users are email-less).
            const [user] = await tx
              .insert(schema.users)
              .values({
                tenantId: DEFAULT_TENANT_ID,
                externalIdentityId: sub,
                argusId: challenge.argusId!, // non-null: guarded above
                displayName,
                role: 'member',
                status: 'active',
              })
              .returning({ id: schema.users.id });
            if (!user) throw new Error('user insert returned no row');

            // Bind sub → tenantId (routing table, no RLS).
            await tx.insert(schema.userTenantIndex).values({ sub, tenantId: DEFAULT_TENANT_ID });

            // Store WebAuthn credential (RLS: tenant_id = DEFAULT_TENANT_ID).
            await tx.insert(schema.webauthnCredentials).values({
              tenantId: DEFAULT_TENANT_ID,
              userId: user.id,
              credentialId: Buffer.from(isoBase64URL.toBuffer(credential.id)),
              publicKey: Buffer.from(credential.publicKey),
              counter: BigInt(credential.counter),
              aaguid: aaguid && aaguid !== '00000000-0000-0000-0000-000000000000' ? aaguid : null,
              backedUp: credentialBackedUp,
              transports: credential.transports ?? null,
            });

            this.logger.log(`passkey registered: argusId=${challenge.argusId}`);
            return { tenantId: DEFAULT_TENANT_ID, userId: user.id, sub };
          },
        );

        // Mint first session post-commit (separate tx; user_tenant_index row now exists).
        return this.sessions.mintSession(result);
      } catch (err) {
        if (isHandleCollision(err) && attempt < MAX_ATTEMPTS - 1) continue;
        // Remap non-HTTP library errors (e.g. WebAuthnError from verifyRegistrationResponse)
        // to 401 — NestJS would otherwise return 500 for internal SimpleWebAuthn rejections.
        if (!(err instanceof HttpException)) throw new UnauthorizedException('registration failed');
        throw err;
      }
    }
    throw new Error('display name exhausted after max attempts');
  }

  /** Generate authentication options with empty allowCredentials (discoverable — no oracle). */
  async getAuthenticationOptions(): Promise<{ ceremonyId: string; options: object }> {
    // Opportunistic sweep of expired challenges — backstop cleanup so abandoned ceremonies
    // (unauthenticated endpoint, no guaranteed verify call) don't accumulate indefinitely.
    // Primary replay protection is still delete-on-use in verifyAuthentication/verifyRegistration.
    await withRouting((tx) =>
      tx
        .delete(schema.webauthnChallenges)
        .where(lt(schema.webauthnChallenges.expiresAt, new Date())),
    );

    const challengeBytes = randomBytes(32);
    const challengeHex = challengeBytes.toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: [],
      userVerification: 'required',
      challenge: challengeBytesFromHex(challengeHex) as Uint8Array<ArrayBuffer>,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    });

    const [row] = await withRouting((tx) =>
      tx
        .insert(schema.webauthnChallenges)
        .values({
          challengeHash: challengeHex,
          purpose: 'authenticate',
          expiresAt,
        })
        .returning({ ceremonyId: schema.webauthnChallenges.ceremonyId }),
    );
    if (!row) throw new Error('challenge insert returned no row');

    return { ceremonyId: row.ceremonyId, options };
  }

  /**
   * Verify authentication response.
   * - Delete the challenge (delete-on-use, primary replay protection).
   * - Resolve identity from the STORED credential row only (passkey-auth.md §T3).
   * - Verify userHandle if present (cross-account login guard).
   * - Check counter regression (clone detection, passkey-auth.md §T5).
   * - Mint session.
   */
  async verifyAuthentication(
    ceremonyId: string,
    response: AuthenticationResponseJSON,
  ): Promise<MintedSession> {
    // Delete challenge first (outside withTenant so we can pass it into the tenant tx).
    const [challenge] = await withRouting((tx) =>
      tx
        .delete(schema.webauthnChallenges)
        .where(
          and(
            eq(schema.webauthnChallenges.ceremonyId, ceremonyId),
            eq(schema.webauthnChallenges.purpose, 'authenticate'),
            gt(schema.webauthnChallenges.expiresAt, new Date()),
          ),
        )
        .returning(),
    );
    if (!challenge) throw new UnauthorizedException('ceremony not found, expired, or already used');

    let regressionArgusId: string | null = null;

    try {
      // Decode rawId inside the try so a malformed base64url value returns 401, not 500.
      // (Challenge is already deleted above; any decode error here is still a controlled failure.)
      const rawId = Buffer.from(isoBase64URL.toBuffer(response.rawId));

      const result = await withTenant(DEFAULT_TENANT_ID, async (tx) => {
        // Identity from stored credential only — never from the client-posted userHandle.
        const cred = await tx
          .select({
            id: schema.webauthnCredentials.id,
            userId: schema.webauthnCredentials.userId,
            credentialId: schema.webauthnCredentials.credentialId,
            publicKey: schema.webauthnCredentials.publicKey,
            counter: schema.webauthnCredentials.counter,
            backedUp: schema.webauthnCredentials.backedUp,
            transports: schema.webauthnCredentials.transports,
            argusId: schema.users.argusId,
          })
          .from(schema.webauthnCredentials)
          .innerJoin(schema.users, eq(schema.users.id, schema.webauthnCredentials.userId))
          .where(
            and(
              eq(schema.webauthnCredentials.credentialId, rawId),
              eq(schema.users.status, 'active'),
            ),
          )
          .limit(1)
          .then((r) => r[0]);

        if (!cred) throw new UnauthorizedException('credential not found');

        // Cross-account login guard (passkey-auth.md §T3).
        const userHandle = response.response?.userHandle;
        if (userHandle) {
          const claimedArgusId = isoUint8Array.toUTF8String(isoBase64URL.toBuffer(userHandle));
          if (claimedArgusId !== cred.argusId) {
            throw new UnauthorizedException('userHandle mismatch');
          }
        }

        const verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: expectedChallengeFromHex(challenge.challengeHash),
          expectedRPID: this.rpID,
          expectedOrigin: this.expectedOrigin,
          requireUserVerification: true,
          credential: {
            id: isoBase64URL.fromBuffer(cred.credentialId as unknown as Uint8Array<ArrayBuffer>),
            publicKey: new Uint8Array(cred.publicKey as Buffer),
            // Pass 0 so the library skips its own counter check — we do it below with BigInt
            // precision and route regressions through the audit path (passkey-auth.md §T5).
            counter: 0,
            transports: (cred.transports ?? []) as Parameters<
              typeof verifyAuthenticationResponse
            >[0]['credential']['transports'],
          },
        });

        if (!verification.verified || !verification.authenticationInfo) {
          throw new UnauthorizedException('assertion verification failed');
        }

        const { newCounter } = verification.authenticationInfo;

        // Clone detection (passkey-auth.md §T5): allow counter=0; reject only regression from >0.
        // BigInt comparison avoids precision loss for very large counter values.
        // NOTE: we pass counter:0 above so the library skips its check; this block is the only gate.
        if (cred.counter > 0n && BigInt(newCounter) <= cred.counter) {
          regressionArgusId = cred.argusId;
          throw new UnauthorizedException(
            'counter regression detected — possible credential clone',
          );
        }

        // Optimistic lock: include the stored counter in the WHERE so concurrent requests
        // with the same credential cannot both win — the second sees 0 rows updated and
        // is treated as a potential clone (passkey-auth.md §T5).
        const updated = await tx
          .update(schema.webauthnCredentials)
          .set({ counter: BigInt(newCounter), lastUsedAt: new Date() })
          .where(
            and(
              eq(schema.webauthnCredentials.id, cred.id),
              eq(schema.webauthnCredentials.counter, cred.counter),
            ),
          )
          .returning({ id: schema.webauthnCredentials.id });
        if (!updated.length) {
          regressionArgusId = cred.argusId;
          throw new UnauthorizedException(
            'counter regression detected — possible credential clone',
          );
        }

        this.logger.log(`passkey authenticated: argusId=${cred.argusId}`);
        return {
          tenantId: DEFAULT_TENANT_ID,
          userId: cred.userId,
          sub: `argusid:${cred.argusId}`,
        };
      });

      return this.sessions.mintSession(result);
    } catch (err) {
      if (regressionArgusId !== null) {
        this.logger.warn(`passkey.counter_regression: argusId=${regressionArgusId}`);
        await this.audit
          .record(DEFAULT_TENANT_ID, {
            eventType: 'passkey.counter_regression',
            actorSub: `argusid:${regressionArgusId}`,
          })
          .catch((auditErr: unknown) =>
            this.logger.error('failed to write counter_regression audit event', auditErr),
          );
      }
      // Remap non-HTTP library errors (e.g. WebAuthnError from verifyAuthenticationResponse)
      // to 401 — NestJS would otherwise return 500 for internal SimpleWebAuthn rejections.
      if (!(err instanceof HttpException)) throw new UnauthorizedException('authentication failed');
      throw err;
    }
  }
}
