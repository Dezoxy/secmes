import { Shield, ShieldCheck, X } from 'lucide-react';

/**
 * Out-of-band safety-number verification (checkpoint 20) — the MITM defense. The number is derived from
 * both devices' identity keys (@argus/crypto `safetyNumber`); users compare it on a trusted channel.
 * A mismatch means a key was swapped. Demo: the number is for the local loopback peer; the live flow
 * uses the remote peer's published key. See docs/threat-models/fingerprint-verification.md.
 */
interface VerifySecurityProps {
  peerName: string;
  safetyNumber: string | null;
  verified: boolean;
  onVerifiedChange: (verified: boolean) => void;
  onClose: () => void;
}

export function VerifySecurity({
  peerName,
  safetyNumber,
  verified,
  onVerifiedChange,
  onClose,
}: VerifySecurityProps) {
  const groups = safetyNumber ? safetyNumber.split(' ') : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {verified ? (
              <ShieldCheck className="h-5 w-5 text-green-400" />
            ) : (
              <Shield className="h-5 w-5 text-purple-400" />
            )}
            <h2 className="text-lg font-semibold text-white">Verify security</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/5 hover:text-white/80"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-sm leading-relaxed text-white/50">
          Compare this safety number with <span className="text-white/80">{peerName}</span> on a
          trusted channel — in person or a call you both recognise. If it matches, your conversation
          is end-to-end encrypted with no one in the middle.
        </p>

        {safetyNumber ? (
          <div className="mb-4 grid grid-cols-4 gap-2 rounded-2xl bg-[#0f0f16] p-4">
            {groups.map((g, i) => (
              <span
                key={i}
                className="text-center font-mono text-sm tracking-widest text-white/90 tabular-nums"
              >
                {g}
              </span>
            ))}
          </div>
        ) : (
          <div className="mb-4 rounded-2xl bg-[#0f0f16] p-4 text-center text-sm text-white/40">
            Computing safety number…
          </div>
        )}

        {verified ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2 rounded-xl bg-green-500/10 py-2.5 text-sm font-medium text-green-400">
              <ShieldCheck className="h-4 w-4" />
              Marked as verified
            </div>
            <button
              type="button"
              onClick={() => onVerifiedChange(false)}
              className="w-full rounded-xl border border-white/5 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white/80"
            >
              Mark as unverified
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={!safetyNumber}
            onClick={() => onVerifiedChange(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/25 transition-all hover:bg-purple-400 disabled:cursor-not-allowed disabled:bg-purple-500/50 disabled:shadow-none"
          >
            <ShieldCheck className="h-4 w-4" />
            They match — mark as verified
          </button>
        )}

        <p className="mt-4 text-xs leading-relaxed text-white/30">
          Demo: this number is computed for a local peer in your browser (the real out-of-band check
          with a remote contact lands with the live message loop). Verification resets if the device
          key changes.
        </p>
      </div>
    </div>
  );
}
