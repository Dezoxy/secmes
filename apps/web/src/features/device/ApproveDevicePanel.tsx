// D1 side of B2 multi-device linking. Fetches the pending enrollment, shows the derived
// fingerprint code for out-of-band verification, and — when the user confirms — signs an
// enroll-approval proof, calls the approve endpoint, then fans D2 out into live conversations.
import { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import { deviceSignatureSeed, enrollmentDisplayCode } from '@argus/crypto';
import { signEnrollApproval } from '@argus/crypto/device-proof';
import {
  approveEnrollment,
  listEnrollments,
  listMyConversations,
  rejectEnrollment,
  type Enrollment,
} from '../../lib/api';
import { enrollDevice } from '../../lib/enroll';
import type { MessagingDeps } from '../../lib/messaging';
import { Button, ErrorState, IconButton, LoadingState, Modal } from '../ui';
import { useDevice } from './DeviceContext';

/** base64url, no padding — the wire form the enroll endpoint expects. */
function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface ApproveDevicePanelProps {
  enrollmentId: string;
  selfUserId: string;
  messagingDeps: MessagingDeps | null;
  /** Live MLS group map (read at approval time, not render time). */
  liveGroupsRef: { current: Map<string, MlsGroup> };
  onClose: () => void;
}

type ApproveState = 'loading' | 'ready' | 'approving' | 'done' | 'error';

export function ApproveDevicePanel({
  enrollmentId,
  selfUserId,
  messagingDeps,
  liveGroupsRef,
  onClose,
}: ApproveDevicePanelProps) {
  const { device, deviceId } = useDevice();
  const [state, setState] = useState<ApproveState>('loading');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [expectedCode, setExpectedCode] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await listEnrollments('pending');
        if (!active) return;
        const found = list.find((e: Enrollment) => e.id === enrollmentId);
        if (!found) {
          setErr(new Error('Enrollment not found or already resolved.'));
          setState('error');
          return;
        }
        const code = await enrollmentDisplayCode(found.fingerprint);
        if (!active) return;
        setEnrollment(found);
        setExpectedCode(code);
        setState('ready');
      } catch (e) {
        if (!active) return;
        setErr(e);
        setState('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [enrollmentId]);

  const normalizedInput = input.replace(/\s/g, '');

  const handleApprove = async () => {
    if (!device || !deviceId || !enrollment || !messagingDeps) return;

    const normalized = input.replace(/\s/g, '');
    const expected = (expectedCode ?? '').replace(/\s/g, '');
    if (normalized !== expected) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setState('approving');

    try {
      const proofBytes = signEnrollApproval(deviceSignatureSeed(device), deviceId, enrollmentId);
      const proof = toBase64Url(proofBytes);
      await approveEnrollment(enrollmentId, deviceId, proof);
      // Approval is now terminal — show done before fan-out so a partial fan-out failure doesn't
      // strand D1 in an error state with no way to retry (the enrollment is already approved).
      // Fan-out is best-effort: on D1 reconnect, useLiveConversations retries any approved
      // enrollments that didn't fully fan-out.
      setState('done');
      void listMyConversations()
        .then((conversationIds) =>
          enrollDevice(
            messagingDeps,
            selfUserId,
            enrollment.requestingDeviceId,
            enrollment.fingerprint,
            conversationIds,
            liveGroupsRef.current,
          ),
        )
        .catch(() => {
          /* best-effort — retry on D1 reconnect via useLiveConversations onReady */
        });
    } catch (e) {
      setErr(e);
      setState('error');
    }
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    if (mismatch) setMismatch(false);
  };

  return (
    <Modal
      ariaLabel="Approve new device"
      onClose={onClose}
      closeOnBackdrop={state === 'done' || state === 'error'}
      className="items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      contentClassName="w-full max-w-sm rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-purple-400" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-white">Approve new device</h2>
        </div>
        <IconButton onClick={onClose} size="sm" aria-label="Close">
          <X className="h-5 w-5" />
        </IconButton>
      </div>

      {state === 'loading' && <LoadingState title="Loading enrollment details" />}

      {(state === 'ready' || state === 'approving') && (
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-white/55">
            A new device wants to join your account. Enter the 9-digit code shown on that device to
            confirm it is yours.
          </p>
          <div>
            <label
              htmlFor="approve-device-code"
              className="mb-2 block text-sm font-medium text-white/70"
            >
              Code shown on new device
            </label>
            <input
              id="approve-device-code"
              type="text"
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder="123 456 789"
              maxLength={11}
              autoComplete="off"
              spellCheck={false}
              inputMode="numeric"
              aria-invalid={mismatch}
              aria-describedby={mismatch ? 'approve-code-error' : undefined}
              className="w-full rounded-xl border border-white/10 bg-[#0f0f16] px-4 py-3 text-center font-mono text-lg tracking-[0.25em] text-white placeholder-white/25 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
            />
            {mismatch && (
              <p id="approve-code-error" role="alert" className="mt-2 text-sm text-rose-400">
                Code doesn&apos;t match — do not approve if this isn&apos;t your device.
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <Button
              variant="ghost"
              size="lg"
              onClick={() => {
                void rejectEnrollment(enrollmentId).catch(() => {});
                onClose();
              }}
              disabled={state === 'approving'}
              className="flex-1 border border-white/5"
            >
              Reject
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={() => void handleApprove()}
              disabled={normalizedInput.length < 9 || state === 'approving'}
              loading={state === 'approving'}
              loadingLabel="Approving…"
              className="flex-1"
            >
              <ShieldCheck className="h-4 w-4" />
              Approve
            </Button>
          </div>
        </div>
      )}

      {state === 'done' && (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <ShieldCheck className="h-12 w-12 text-green-400" aria-hidden="true" />
          <div>
            <p className="text-lg font-semibold text-white">Device approved!</p>
            <p className="mt-1 text-sm text-white/55">
              The new device has been added to your account.
            </p>
          </div>
          <Button variant="subtle" size="lg" onClick={onClose} className="w-full">
            Done
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
