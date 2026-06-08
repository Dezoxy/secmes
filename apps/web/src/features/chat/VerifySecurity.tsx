import { Shield, ShieldCheck, X } from 'lucide-react';
import { Button, IconButton, Modal } from '../ui';

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
  /** 'live' = a real remote peer (gates a new conversation); 'demo' = the local loopback peer. */
  mode?: 'demo' | 'live';
  /** Optional inline error (e.g. a failed conversation create) shown above the action. */
  error?: string | null;
}

export function VerifySecurity({
  peerName,
  safetyNumber,
  verified,
  onVerifiedChange,
  onClose,
  mode = 'demo',
  error,
}: VerifySecurityProps) {
  const groups = safetyNumber ? safetyNumber.split(' ') : [];

  return (
    <Modal
      ariaLabel="Verify security"
      onClose={onClose}
      closeOnBackdrop
      className="items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      contentClassName="w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50"
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
        <IconButton onClick={onClose} size="sm" aria-label="Close security verification">
          <X className="h-5 w-5" />
        </IconButton>
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

      {error && <p className="mb-3 text-center text-xs text-red-400/80">{error}</p>}

      {verified ? (
        <div className="space-y-3">
          <div className="flex items-center justify-center gap-2 rounded-xl bg-green-500/10 py-2.5 text-sm font-medium text-green-400">
            <ShieldCheck className="h-4 w-4" />
            Marked as verified
          </div>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => onVerifiedChange(false)}
            className="w-full border border-white/5 text-white/60 hover:bg-white/5 hover:text-white/80"
          >
            Mark as unverified
          </Button>
        </div>
      ) : (
        <Button
          disabled={!safetyNumber}
          onClick={() => onVerifiedChange(true)}
          size="lg"
          className="w-full shadow-purple-500/25 disabled:bg-purple-500/50 disabled:shadow-none"
        >
          <ShieldCheck className="h-4 w-4" />
          They match — mark as verified
        </Button>
      )}

      <p className="mt-4 text-xs leading-relaxed text-white/30">
        {mode === 'live'
          ? 'Compare every digit out-of-band — in person or on a call you both recognise. If it does not match, stop: a key may have been swapped in transit. Verification resets if the device key changes.'
          : 'Demo: this number is computed for a local peer in your browser (the real out-of-band check with a remote contact lands with the live message loop). Verification resets if the device key changes.'}
      </p>
    </Modal>
  );
}
