// Access token held in module-level memory ONLY — never localStorage/sessionStorage.
// api-client.ts reads this; AuthContext writes it after each passkey ceremony or session refresh.

let _token: string | null = null;

export function setToken(t: string | null): void {
  _token = t;
}

/** The current in-memory access token (or null). Kept async so api-client.ts needs no changes. */
export async function accessToken(): Promise<string | null> {
  return _token;
}

/** True when the app runs without real auth. Set VITE_DEMO_MODE=1 to enable. */
export const demoMode: boolean =
  import.meta.env.VITE_DEMO_MODE === '1' || import.meta.env.VITE_DEMO_MODE === 'true';
