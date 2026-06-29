// Fetch and shape ephemeral TURN credentials for one call attempt.
// The `credential` field is HMAC-SHA1 secret-equivalent — never cached, never logged.
// Re-fetch per call: the TTL is 600–1200 s, which comfortably spans a single call.

import { fetchTurnCredentials } from './api';

/** The configuration needed to initialise an RTCPeerConnection with coturn relay. */
export interface TurnConfig {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
}

/**
 * Fetch fresh TURN credentials and return them shaped for RTCPeerConnection.
 * Never caches the result — callers must call once per call attempt.
 * The HMAC credential is forwarded directly to the browser RTCPeerConnection
 * and is never passed to any logger.
 */
export async function loadTurnConfig(): Promise<TurnConfig> {
  const resp = await fetchTurnCredentials();
  return {
    iceServers: resp.iceServers.map((s) => ({
      urls: s.urls,
      ...(s.username !== undefined && { username: s.username }),
      ...(s.credential !== undefined && { credential: s.credential }),
    })),
    iceTransportPolicy: resp.iceTransportPolicy,
  };
}
