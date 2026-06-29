// Audio-only media device access for VoIP calls. Never requests video in V1.
// Device labels are only populated after permission is granted — never logged regardless.

/** Result of a microphone permission pre-flight (does NOT prompt). */
export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

/**
 * Query the current microphone permission state without triggering a prompt.
 * Returns 'unavailable' when the Permissions API is absent (some non-PWA contexts).
 */
export async function queryMicPermission(): Promise<MicPermission> {
  if (typeof navigator === 'undefined' || !navigator.permissions) return 'unavailable';
  try {
    const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (result.state === 'granted' || result.state === 'denied' || result.state === 'prompt') {
      return result.state;
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Request a live audio-only stream. Prompts the user if permission is 'prompt'.
 * Throws if the user denies access or if getUserMedia is unavailable.
 * V1 is audio-only; the video constraint is explicitly false so no camera LED lights up.
 */
export async function getAudioStream(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia is not available in this context');
  }
  return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

/**
 * Enumerate available audio input devices.
 * Labels are empty strings until permission is granted — never log them.
 */
export async function enumerateAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}
