import { z } from 'zod';

// D2 registers a pending enrollment request, providing:
// - fingerprint: the hex/base64 string D2 displays as a QR code / 6-digit code (public, derived from
//   D2's signature key). D1 compares this out-of-band to the fingerprint of the claimed KeyPackage.
// - deviceId: D2's own server device UUID (returned by POST /devices/me/key-packages). Used to
//   populate requesting_device_id; the server verifies device ownership via RLS + user_id match.
export const EnrollmentRegisterBodySchema = z
  .object({
    fingerprint: z.string().min(1).max(512),
    deviceId: z.string().uuid(),
  })
  .strict();
export type EnrollmentRegisterBody = z.infer<typeof EnrollmentRegisterBodySchema>;

// D1 approves D2's enrollment by submitting:
// - approvingDeviceId: D1's own server device UUID (for audit + proof verification).
// - proof: base64url Ed25519 signature — signEnrollApproval(D1.privKey, approvingDeviceId, enrollmentId).
//   The server verifies this against D1's published signature public key; a bad/forged proof → 404.
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');
export const EnrollmentApproveBodySchema = z
  .object({
    approvingDeviceId: z.string().uuid(),
    proof: base64url.max(256),
  })
  .strict();
export type EnrollmentApproveBody = z.infer<typeof EnrollmentApproveBodySchema>;

export const WithdrawDeviceBodySchema = z
  .object({
    signaturePublicKey: z.string().min(1).max(512),
    proof: base64url.max(128),
  })
  .strict();
export type WithdrawDeviceBody = z.infer<typeof WithdrawDeviceBodySchema>;
