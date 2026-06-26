// D2 side of B2 multi-device linking. Displays the device's full-width safety number (derived from
// D2's OWN signing key — never anything server-returned, so a server key-swap shifts it and D1 sees
// the mismatch), registers an enrollment request, and polls until the other device approves.
import { useEffect, useState } from 'react';
import { CheckCircle, Link2, X } from 'lucide-react';
import { enrollmentSafetyNumber } from '@argus/crypto';
import { listEnrollments, registerEnrollment, type Enrollment } from '../../lib/api';
import { toBase64 } from '../../lib/base64';
import { Button, ErrorState, IconButton, LoadingState, Modal } from '../ui';
import { useDevice } from './DeviceContext';

type LinkState = 'registering' | 'awaiting' | 'linked' | 'rejected' | 'error';

interface LinkDevicePanelProps {
  onClose: () => void;
  onLinked?: () => void;
}

export function LinkDevicePanel({ onClose, onLinked }: LinkDevicePanelProps) {
  const { device, deviceId } = useDevice();
  const [state, setState] = useState<LinkState>('registering');
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  // Register enrollment on mount and derive the safety number from D2's own signing key.
  useEffect(() => {
    if (!device || !deviceId) {
      setErr(new Error('Device not ready. Unlock your device first.'));
      setState('error');
      return;
    }
    const fingerprint = toBase64(device.publicPackage.leafNode.signaturePublicKey);
    let active = true;
    void (async () => {
      try {
        const n = await enrollmentSafetyNumber(fingerprint);
        if (!active) return;
        setSafetyNumber(n);
        const enrollment = await registerEnrollment(deviceId, fingerprint);
        if (!active) return;
        setEnrollmentId(enrollment.id);
        setState('awaiting');
      } catch (e) {
        if (!active) return;
        setErr(e);
        setState('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [device, deviceId]);

  // Poll every 3 s. When the enrollment disappears from pending, confirm it was approved before
  // showing success — it may have been rejected or expired instead.
  useEffect(() => {
    if (state !== 'awaiting' || !enrollmentId) return;
    const t = setInterval(() => {
      void listEnrollments('pending')
        .then(async (list: Enrollment[]) => {
          if (list.some((e) => e.id === enrollmentId)) return; // still pending
          const approved = await listEnrollments('approved');
          if (approved.some((e) => e.id === enrollmentId)) {
            setState('linked');
            onLinked?.();
          } else {
            setState('rejected'); // expired or rejected by D1
          }
        })
        .catch(() => {});
    }, 3_000);
    return () => clearInterval(t);
  }, [state, enrollmentId, onLinked]);

  return (
    <Modal
      ariaLabel="Link this device"
      onClose={onClose}
      closeOnBackdrop={state === 'error' || state === 'linked' || state === 'rejected'}
      className="items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      contentClassName="w-full max-w-sm rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-purple-400" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-white">Link this device</h2>
        </div>
        <IconButton onClick={onClose} size="sm" aria-label="Close link device">
          <X className="h-5 w-5" />
        </IconButton>
      </div>

      {state === 'registering' && <LoadingState title="Preparing your safety number" />}

      {state === 'awaiting' && (
        <>
          <p className="mb-5 text-sm leading-relaxed text-white/55">
            On your already-linked device, open{' '}
            <strong className="text-white/80">Settings → Devices</strong> and compare this safety
            number — approve only if every group matches.
          </p>
          {safetyNumber ? (
            <div
              className="mb-5 grid grid-cols-4 gap-2 rounded-2xl bg-[#0f0f16] p-4"
              aria-live="polite"
              aria-label={`Safety number: ${safetyNumber}`}
            >
              {safetyNumber.split(' ').map((g, i) => (
                <span
                  key={i}
                  className="text-center font-mono text-base tracking-widest text-white/90 tabular-nums"
                >
                  {g}
                </span>
              ))}
            </div>
          ) : (
            <div
              className="mb-5 rounded-2xl bg-[#0f0f16] p-4 text-center text-sm text-white/60"
              aria-live="polite"
            >
              Computing safety number…
            </div>
          )}
          <p className="flex items-center justify-center gap-2 text-sm text-white/40">
            <span
              className="inline-block h-2 w-2 animate-pulse rounded-full bg-purple-400"
              aria-hidden="true"
            />
            Awaiting approval on your other device…
          </p>
        </>
      )}

      {state === 'linked' && (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <CheckCircle className="h-12 w-12 text-green-400" aria-hidden="true" />
          <div>
            <p className="text-lg font-semibold text-white">Device linked!</p>
            <p className="mt-1 text-sm text-white/55">
              Your conversations will start appearing on this device.
            </p>
          </div>
          <Button variant="subtle" size="lg" onClick={onClose} className="w-full">
            Done
          </Button>
        </div>
      )}

      {state === 'rejected' && (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <X className="h-12 w-12 text-rose-400" aria-hidden="true" />
          <div>
            <p className="text-lg font-semibold text-white">Enrollment expired or rejected</p>
            <p className="mt-1 text-sm text-white/55">
              The request was not approved in time or was rejected. Try linking again.
            </p>
          </div>
          <Button variant="subtle" size="lg" onClick={onClose} className="w-full">
            Close
          </Button>
        </div>
      )}

      {state === 'error' && (
        <div className="space-y-4">
          <ErrorState error={err} />
          <Button
            variant="ghost"
            size="lg"
            onClick={onClose}
            className="w-full border border-white/5"
          >
            Close
          </Button>
        </div>
      )}
    </Modal>
  );
}
