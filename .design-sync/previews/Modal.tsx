import { Button, IconButton, Modal } from '@argus/web';

// Ported from the app's real safety-number verification dialog (features/chat/VerifySecurity.tsx) —
// argus's out-of-band MITM defense: users compare a number derived from both devices' identity keys
// over a trusted channel. Real composition and copy, simplified to a single static state for the card.
export function VerifySafetyNumber() {
  return (
    <Modal
      ariaLabel="Verify security"
      onClose={() => {}}
      closeOnBackdrop
      className="items-center justify-center bg-black/40 p-4 backdrop-blur-md"
      contentClassName="w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">Verify security</h2>
        </div>
        <IconButton size="sm" aria-label="Close security verification">
          <span aria-hidden="true">×</span>
        </IconButton>
      </div>

      <p className="mb-4 text-sm leading-relaxed text-white/50">
        Compare this safety number with <span className="text-white/80">Priya Sharma</span> on a
        trusted channel — in person or a call you both recognise. If it matches, your conversation
        is end-to-end encrypted with no one in the middle.
      </p>

      <div className="mb-4 grid grid-cols-4 gap-2 rounded-2xl bg-[#0f0f16] p-4">
        {['48291', '77103', '65582', '10294', '38857', '92014', '55631', '20489'].map((g) => (
          <span
            key={g}
            className="text-center font-mono text-sm tracking-widest text-white/90 tabular-nums"
          >
            {g}
          </span>
        ))}
      </div>

      <Button size="lg" className="w-full shadow-purple-500/25">
        They match — mark as verified
      </Button>

      <p className="mt-4 text-xs leading-relaxed text-white/60">
        Compare every digit out-of-band — in person or on a call you both recognise. If it does not
        match, stop: a key may have been swapped in transit. Verification resets if the device key
        changes.
      </p>
    </Modal>
  );
}
