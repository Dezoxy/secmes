import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPeerConnection, type PeerConnectionCallbacks } from './peer-connection';
import type { TurnConfig } from './turn-credentials';

// Minimal fake RTCPeerConnection that records calls and lets tests drive events.
class FakePC {
  static instances: FakePC[] = [];
  capturedConfig: RTCConfiguration;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  private handlers: Record<string, ((ev: unknown) => void)[]> = {};
  senders: { track: MediaStreamTrack; streams: MediaStream[] }[] = [];

  constructor(config: RTCConfiguration) {
    this.capturedConfig = config;
    FakePC.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.handlers[type] ??= []).push(cb);
  }

  emit(type: string, ev: unknown): void {
    for (const cb of this.handlers[type] ?? []) cb(ev);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\nfake-offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\nfake-answer-sdp' };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: RTCSessionDescription): Promise<void> {
    this.remoteDescription = { type: desc.type, sdp: desc.sdp };
  }

  async addIceCandidate(): Promise<void> {}

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    this.senders.push({ track, streams });
    return {} as RTCRtpSender;
  }

  close(): void {}
}

class FakeRTCSessionDescription {
  constructor(public readonly init: RTCSessionDescriptionInit) {}
  get type() {
    return this.init.type;
  }
  get sdp() {
    return this.init.sdp ?? '';
  }
}

class FakeRTCIceCandidate {
  constructor(public readonly init: RTCIceCandidateInit) {}
}

const TURN_CONFIG: TurnConfig = {
  iceServers: [{ urls: ['turn:turn.4rgus.com:3478'], username: '123:u', credential: 'secret' }],
  iceTransportPolicy: 'relay',
};

const noop = () => {};
const makeCallbacks = (
  overrides: Partial<PeerConnectionCallbacks> = {},
): PeerConnectionCallbacks => ({
  onConnectionStateChange: noop,
  onIceCandidate: noop,
  onRemoteTrack: noop,
  ...overrides,
});

beforeEach(() => {
  FakePC.instances = [];
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('RTCSessionDescription', FakeRTCSessionDescription);
  vi.stubGlobal('RTCIceCandidate', FakeRTCIceCandidate);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPeerConnection', () => {
  it('creates RTCPeerConnection with relay policy and max-bundle', () => {
    createPeerConnection(TURN_CONFIG, makeCallbacks());
    const pc = FakePC.instances[0]!;
    expect(pc.capturedConfig.iceTransportPolicy).toBe('relay');
    expect(pc.capturedConfig.bundlePolicy).toBe('max-bundle');
    expect(pc.capturedConfig.iceServers).toEqual(TURN_CONFIG.iceServers);
  });

  it('createOffer sets local description and returns the offer dict', async () => {
    const apc = createPeerConnection(TURN_CONFIG, makeCallbacks());
    const offer = await apc.createOffer();
    const pc = FakePC.instances[0]!;
    expect(pc.localDescription).not.toBeNull();
    expect(offer.type).toBe('offer');
    expect(typeof offer.sdp).toBe('string');
  });

  it('acceptOffer sets both descriptions and returns an answer', async () => {
    const apc = createPeerConnection(TURN_CONFIG, makeCallbacks());
    const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0\r\noffer' };
    const answer = await apc.acceptOffer(offer);
    const pc = FakePC.instances[0]!;
    expect(pc.remoteDescription?.type).toBe('offer');
    expect(pc.localDescription?.type).toBe('answer');
    expect(answer.type).toBe('answer');
  });

  it('acceptAnswer sets the remote description', async () => {
    const apc = createPeerConnection(TURN_CONFIG, makeCallbacks());
    const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\nanswer' };
    await apc.acceptAnswer(answer);
    const pc = FakePC.instances[0]!;
    expect(pc.remoteDescription?.type).toBe('answer');
  });

  it('fires onConnectionStateChange on connectionstatechange event', () => {
    const onConnectionStateChange = vi.fn();
    createPeerConnection(TURN_CONFIG, makeCallbacks({ onConnectionStateChange }));
    const pc = FakePC.instances[0]!;
    pc.connectionState = 'connected';
    pc.emit('connectionstatechange', {});
    expect(onConnectionStateChange).toHaveBeenCalledWith('connected');
  });

  it('fires onIceCandidate with toJSON() result when a candidate is available', () => {
    const onIceCandidate = vi.fn();
    createPeerConnection(TURN_CONFIG, makeCallbacks({ onIceCandidate }));
    const pc = FakePC.instances[0]!;
    const candidateInit = { candidate: 'candidate:1 1 udp 1 10.0.0.1 50000 typ host', sdpMid: '0' };
    const fakeCandidate = { toJSON: () => candidateInit };
    pc.emit('icecandidate', { candidate: fakeCandidate });
    expect(onIceCandidate).toHaveBeenCalledWith(candidateInit);
  });

  it('fires onIceCandidate with empty candidate sentinel at end-of-candidates', () => {
    const onIceCandidate = vi.fn();
    createPeerConnection(TURN_CONFIG, makeCallbacks({ onIceCandidate }));
    const pc = FakePC.instances[0]!;
    pc.emit('icecandidate', { candidate: null });
    expect(onIceCandidate).toHaveBeenCalledWith({ candidate: '' });
  });

  it('fires onRemoteTrack when a remote track arrives', () => {
    const onRemoteTrack = vi.fn();
    createPeerConnection(TURN_CONFIG, makeCallbacks({ onRemoteTrack }));
    const pc = FakePC.instances[0]!;
    const track = {} as MediaStreamTrack;
    const streams = [{}] as MediaStream[];
    pc.emit('track', { track, streams });
    expect(onRemoteTrack).toHaveBeenCalledWith(track, streams);
  });

  it('addTrack forwards to the underlying PC', () => {
    const apc = createPeerConnection(TURN_CONFIG, makeCallbacks());
    const track = {} as MediaStreamTrack;
    const stream = {} as MediaStream;
    apc.addTrack(track, stream);
    const pc = FakePC.instances[0]!;
    expect(pc.senders[0]?.track).toBe(track);
  });

  it('buffers ICE candidates added before remote description is set, then flushes on acceptAnswer', async () => {
    const apc = createPeerConnection(TURN_CONFIG, makeCallbacks());
    const pc = FakePC.instances[0]!;
    const addCandidateSpy = vi.spyOn(pc, 'addIceCandidate');

    const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 50000 typ host' };
    await apc.addIceCandidate(candidate); // remote desc not set yet — should buffer
    expect(addCandidateSpy).not.toHaveBeenCalled();

    const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\nanswer' };
    await apc.acceptAnswer(answer); // sets remote desc → should flush the buffered candidate
    expect(addCandidateSpy).toHaveBeenCalledOnce();
  });

  it('buffers ICE candidates added before acceptOffer and flushes after setRemoteDescription', async () => {
    const apc = createPeerConnection(TURN_CONFIG, makeCallbacks());
    const pc = FakePC.instances[0]!;
    const addCandidateSpy = vi.spyOn(pc, 'addIceCandidate');

    const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.2 50001 typ host' };
    await apc.addIceCandidate(candidate); // buffered before remote desc
    expect(addCandidateSpy).not.toHaveBeenCalled();

    const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0\r\noffer' };
    await apc.acceptOffer(offer); // sets remote desc → flush
    expect(addCandidateSpy).toHaveBeenCalledOnce();
  });

  it('adds ICE candidates directly after remote description is set', async () => {
    const apc = createPeerConnection(TURN_CONFIG, makeCallbacks());
    const pc = FakePC.instances[0]!;
    const addCandidateSpy = vi.spyOn(pc, 'addIceCandidate');

    const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\nanswer' };
    await apc.acceptAnswer(answer); // remote desc now set

    const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.3 50002 typ host' };
    await apc.addIceCandidate(candidate); // should go directly, no buffering
    expect(addCandidateSpy).toHaveBeenCalledOnce();
  });
});
