// Realtime message delivery over the `/ws` gateway (Slice 5 PR-5C). A reconnecting client that authenticates
// in the FIRST APP FRAME (never a token in the URL/query — that would land in proxy/access logs), subscribes
// to the caller's live conversations, and surfaces each pushed CIPHERTEXT envelope for local decryption. The
// gateway is crypto-blind: it forwards opaque ciphertext + metadata only; all decryption is client-side.
//
// On every (re)connect the socket re-authenticates, re-subscribes its tracked conversations, then fires
// `onReady` so the caller can run a per-conversation catch-up fetch for anything missed while disconnected
// (the gateway only pushes while connected). Dedup across push + catch-up is by the server message id.

import type { FetchedMessage } from './api';

/** A message pushed by the gateway — the conversation it belongs to + the opaque envelope. */
export interface IncomingMessage {
  conversationId: string;
  message: FetchedMessage;
}

export interface MessageSocketOptions {
  /** ws(s):// URL of the gateway. Defaults to same-origin `/ws` (dev: Vite proxy; prod: the app origin). */
  url?: string;
  /** Supplies the current access token for the first-frame auth. Read per (re)connect, never cached in a URL. */
  token: () => Promise<string | null>;
  /** A ciphertext envelope was pushed for a subscribed conversation. */
  onMessage: (msg: IncomingMessage) => void;
  /** (Re)connected + authenticated + re-subscribed. A connection-status signal (catch-up runs per-room). */
  onReady?: () => void;
  /**
   * The gateway ACKNOWLEDGED a subscription — the socket is now IN the room, so it's safe to run a catch-up
   * fetch for this conversation. Doing it here (not on `onReady`) closes a race: the server joins the room
   * only after an async membership check, so a message committed between a too-early catch-up and the join
   * would be neither fetched nor pushed. After the ack, anything past the catch-up's cursor is pushed live.
   */
  onSubscribed?: (conversationId: string) => void;
  /** Injectable WebSocket constructor (tests). Defaults to the global. */
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect backoff knobs (tests tune these down). */
  reconnect?: { baseMs?: number; maxMs?: number };
}

export interface MessageSocket {
  /** Track + subscribe a conversation (idempotent). Sent now if authenticated, else on the next (re)connect. */
  subscribe(conversationId: string): void;
  /** Tear down: stop reconnecting and close the socket. */
  close(): void;
}

const OPEN = 1; // WebSocket.OPEN — avoid referencing the global (absent in some test envs)

/**
 * The gateway URL. Precedence mirrors `lib/api.ts`'s REST base so a SPLIT deployment works:
 * 1. `VITE_WS_URL` — explicit override.
 * 2. `VITE_API_URL` (the REST API base, when absolute) — same host, ws(s) scheme, `/ws` path; otherwise the
 *    socket would dial the static web origin while REST/sends go to the API host (live delivery never
 *    connects).
 * 3. Same origin `/ws` — dev (Vite proxy) or a PWA served from the API origin.
 */
export function defaultWsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return explicit;
  const apiBase = import.meta.env.VITE_API_URL as string | undefined;
  if (apiBase && /^https?:\/\//i.test(apiBase)) {
    return `${apiBase.replace(/^http/i, 'ws').replace(/\/+$/, '')}/ws`;
  }
  if (typeof window === 'undefined') return 'ws://localhost/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/**
 * Create a reconnecting realtime message socket. Connects immediately; the caller drives subscriptions via
 * `subscribe()` and reacts to pushes via `onMessage` and to (re)connection via `onReady`.
 */
export function createMessageSocket(opts: MessageSocketOptions): MessageSocket {
  const WS = opts.WebSocketImpl ?? (globalThis.WebSocket as typeof WebSocket | undefined);
  const url = opts.url ?? defaultWsUrl();
  const baseMs = opts.reconnect?.baseMs ?? 1000;
  const maxMs = opts.reconnect?.maxMs ?? 30_000;

  const subs = new Set<string>();
  let ws: WebSocket | null = null;
  let authed = false;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const sendSubscribe = (socket: WebSocket, conversationId: string): void => {
    if (socket.readyState === OPEN) {
      socket.send(JSON.stringify({ event: 'subscribe', data: { conversationId } }));
    }
  };

  const handleFrame = (socket: WebSocket, frame: { event?: unknown; data?: unknown }): void => {
    if (frame.event === 'ready') {
      authed = true;
      attempt = 0; // a successful auth resets the backoff
      for (const id of subs) sendSubscribe(socket, id);
      opts.onReady?.();
      return;
    }
    if (frame.event === 'message') {
      if (!authed) return; // ignore any pre-auth push — don't act on a frame before `ready` (defence in depth)
      const data = frame.data as Partial<IncomingMessage> | null;
      if (data && typeof data.conversationId === 'string' && data.message) {
        opts.onMessage({ conversationId: data.conversationId, message: data.message });
      }
      return;
    }
    if (frame.event === 'subscribed') {
      // The room join is confirmed — now safe to catch up this conversation (see onSubscribed).
      const id = (frame.data as { conversationId?: unknown } | null)?.conversationId;
      if (typeof id === 'string') opts.onSubscribed?.(id);
      return;
    }
    // 'error' frames need no client action (membership/authz is server-enforced; the keys gate content).
  };

  const scheduleReconnect = (): void => {
    ws = null;
    authed = false;
    if (closed || !WS) return;
    // Exponential backoff with a capped exponent (so `2 ** attempt` can't overflow) + ±20% CSPRNG jitter
    // (Math.random is banned — argus-no-insecure-random) to avoid a reconnect thundering herd on a gateway
    // restart. The delay itself is also clamped to `maxMs`.
    const base = Math.min(baseMs * 2 ** Math.min(attempt, 16), maxMs);
    attempt += 1;
    const jitter = 0.8 + 0.4 * (crypto.getRandomValues(new Uint32Array(1))[0]! / 0xffffffff);
    reconnectTimer = setTimeout(connect, Math.round(base * jitter));
  };

  function connect(): void {
    if (closed || !WS) return;
    const socket = new WS(url);
    ws = socket;
    socket.addEventListener('open', () => {
      // Authenticate in the FIRST FRAME — the token is sent in the app payload, never the URL.
      void opts.token().then((token) => {
        if (socket.readyState !== OPEN) return;
        if (!token) {
          socket.close(); // no token yet — a reconnect will retry once one is available
          return;
        }
        socket.send(JSON.stringify({ event: 'auth', data: { token } }));
      });
    });
    socket.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let frame: { event?: unknown; data?: unknown };
      try {
        frame = JSON.parse(ev.data) as { event?: unknown; data?: unknown };
      } catch {
        return; // ignore non-JSON frames
      }
      handleFrame(socket, frame);
    });
    socket.addEventListener('close', () => {
      if (ws === socket) scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      try {
        socket.close();
      } catch {
        /* the close handler drives reconnect */
      }
    });
  }

  connect();

  return {
    subscribe(conversationId: string): void {
      subs.add(conversationId);
      if (ws && authed) sendSubscribe(ws, conversationId);
    },
    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      authed = false;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        ws = null;
      }
    },
  };
}
