// UI-free RTCPeerConnection wrapper for 1:1 audio calls.
// bundlePolicy:'max-bundle' — all media on one DTLS association (simpler for relay-only calls).
// iceTransportPolicy:'relay' — forced by the server-returned TurnConfig; peer IPs never exposed in V1.
// Caller is impolite, callee is polite under perfect negotiation (V1.1 mid-call renegotiation).

import type { IceCandidate, Sdp } from '@argus/contracts';
import type { TurnConfig } from './turn-credentials';

/** Callbacks from the live RTCPeerConnection to the call state machine. */
export interface PeerConnectionCallbacks {
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  /** Trickled ICE candidate ready to send to the peer (includes the end-of-candidates sentinel `''`). */
  onIceCandidate: (candidate: IceCandidate) => void;
  onRemoteTrack: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
}

/** Handle to the live peer connection. All SDP methods are async; ICE trickles via callbacks. */
export interface ArgusPC {
  /** Caller side: create and set the local SDP offer. Returns the offer to encrypt and send. */
  createOffer(): Promise<Sdp>;
  /** Callee side: set the remote offer and create + set the local SDP answer. Returns the answer. */
  acceptOffer(offer: Sdp): Promise<Sdp>;
  /** Caller side: set the callee's SDP answer as the remote description. */
  acceptAnswer(answer: Sdp): Promise<void>;
  /** Apply a trickled ICE candidate received from the peer. */
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  /** Add a local audio track from getUserMedia to the connection. */
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender;
  /**
   * ICE-restart: mint a fresh offer with iceRestart:true.
   * V1.1 reconnect path (P3-ICE). Wired here so P1-SIG can call it; reconnect state machine is later.
   */
  startIceRestart(): Promise<Sdp>;
  close(): void;
}

/**
 * Create a new peer connection configured with the given TURN relay credentials.
 * The `pc` is instantiated with `bundlePolicy:'max-bundle'` and the server's `iceTransportPolicy`
 * ('relay' in V1) — callers never change this; the server enforces the relay default.
 */
export function createPeerConnection(
  config: TurnConfig,
  callbacks: PeerConnectionCallbacks,
): ArgusPC {
  const pc = new RTCPeerConnection({
    iceServers: config.iceServers,
    iceTransportPolicy: config.iceTransportPolicy,
    bundlePolicy: 'max-bundle',
  });

  pc.addEventListener('connectionstatechange', () => {
    callbacks.onConnectionStateChange(pc.connectionState);
  });

  pc.addEventListener('icecandidate', (ev: RTCPeerConnectionIceEvent) => {
    if (ev.candidate) {
      // ev.candidate.candidate is always a non-undefined string on a real candidate event.
      const init = ev.candidate.toJSON();
      callbacks.onIceCandidate({ ...init, candidate: init.candidate ?? '' });
    } else {
      // End-of-candidates sentinel — empty string per spec.
      callbacks.onIceCandidate({ candidate: '' });
    }
  });

  pc.addEventListener('track', (ev: RTCTrackEvent) => {
    callbacks.onRemoteTrack(ev.track, ev.streams);
  });

  // ICE candidates can arrive before the remote description is set (trickle ICE race).
  // Buffer them and flush once setRemoteDescription is called.
  let remoteDescSet = false;
  const pendingCandidates: IceCandidate[] = [];

  async function flushPendingCandidates(): Promise<void> {
    for (const c of pendingCandidates.splice(0)) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
  }

  return {
    async createOffer(): Promise<Sdp> {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // pc.createOffer() always returns type:'offer' — assert to satisfy the contract.
      return { type: offer.type as 'offer', sdp: offer.sdp ?? '' };
    },

    async acceptOffer(offer: Sdp): Promise<Sdp> {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      remoteDescSet = true;
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // pc.createAnswer() always returns type:'answer' — assert to satisfy the contract.
      return { type: answer.type as 'answer', sdp: answer.sdp ?? '' };
    },

    async acceptAnswer(answer: Sdp): Promise<void> {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      remoteDescSet = true;
      await flushPendingCandidates();
    },

    async addIceCandidate(candidate: IceCandidate): Promise<void> {
      if (!remoteDescSet) {
        pendingCandidates.push(candidate);
        return;
      }
      // Empty string candidate is the end-of-candidates sentinel — pass through as-is.
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    },

    addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
      return pc.addTrack(track, stream);
    },

    async startIceRestart(): Promise<Sdp> {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      return { type: offer.type as 'offer', sdp: offer.sdp ?? '' };
    },

    close(): void {
      pc.close();
    },
  };
}
