// D1 side of B2 multi-device linking. Fetches the pending enrollment, shows the derived full-width
// safety number for out-of-band visual comparison against the number D2 displays, and — when the user
// confirms they match — signs an enroll-approval proof, calls the approve endpoint, then fans D2 out
// into live conversations.
import { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import { deviceSignatureSeed, enrollmentSafetyNumber } from '@argus/crypto';
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
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
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
        // Derived from the server-relayed fingerprint: if the server swapped D2's key, this number
        // diverges from the one D2 shows (computed from its own key) and the human compare catches it.
        const number = await enrollmentSafetyNumber(found.fingerprint);
        if (!active) return;
        setEnrollment(found);
        setSafetyNumber(number);
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

  // Approve IS the human assertion that the two displayed safety numbers match — there is no typed
  // entry to compare, so the user must have eyeballed all 8 groups before pressing it.
  const handleApprove = async () => {
    if (!device || !deviceId || !enrollment || !messagingDeps || !safetyNumber) return;

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
            A new device wants to join your account. Compare this safety number with the one shown
            on that device — approve only if every group matches.
          </p>
          {safetyNumber ? (
            <div
              className="grid grid-cols-4 gap-2 rounded-2xl bg-[#0f0f16] p-4"
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
            <div className="rounded-2xl bg-[#0f0f16] p-4 text-center text-sm text-white/60">
              Computing safety number…
            </div>
          )}
          <p role="note" className="text-sm text-rose-400/90">
            Do not approve if this isn&apos;t your device or the numbers don&apos;t match.
          </p>
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
              disabled={!safetyNumber || state === 'approving'}
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
