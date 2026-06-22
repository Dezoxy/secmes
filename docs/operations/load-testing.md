# Load-testing procedure

> **Roadmap checkpoint 50 (Resilience).** A repeatable load test that validates the API + realtime gateway
> hold their SLOs at the target concurrency. This page carries the **ready-to-run scripts inline** — copy them
> out and run them. There is no committed `infra/loadtest/` tree and **no new dependency**: the load generator
> is [k6](https://k6.io) via its official Docker image.

> **Status — harness built, at-scale run gated on arming.** Locally this runs as a low-VU **smoke** check (the
> mechanism below is validated against `make up`). The **at-scale run to target concurrency** needs the *armed*
> deployment — run it at go-live and record the result in [§6](#6-results-log).

## 1. Targets & pass/fail (proposed — override)

The first deploy is a ~2 vCPU / 4 GiB box (`t3.medium` default; `c7i-flex.large`) running the **whole** stack
(Postgres + Redis + API + observability), so the target is deliberately conservative for the beta:

| Dimension | Target | Rationale |
| --- | --- | --- |
| Concurrent **authenticated WS** connections | **200** sustained | Open-socket memory is the first ceiling a single-VM messaging server hits; this is the capacity number that matters. |
| Authenticated **REST** read throughput | **~50 req/s** sustained | Member-gated reads exercise the auth guard + RLS-scoped DB path. |
| **Ramp** | 0 → target over ~30 s, hold ~1 min, ramp down | Find the **knee** (where p95 degrades), not just a pass/fail at one point. |

**Pass/fail is tied to the existing SLOs** (`prometheus/rules/argus-api.yml`, see
[deploy.md](../architecture/deploy.md)):

- `http_req_duration` **p95 < 1 s**
- `http_req_failed` **< 1 %**
- WS connect+auth success **> 99 %**

**Rate limits to stay under** (so the test measures capacity, not the throttler —
[rate-limit.constants.ts](../../apps/api/src/rate-limit/rate-limit.constants.ts)): global **120 req/min per
user** (so each token paces ≤ ~2 req/s — the seed mints enough tokens to spread load), and **120 new-room
subscribes/min per socket** (each socket subscribes once). The edge (Cloudflare/Caddy) adds per-IP caps; run the
load generator from inside the trust boundary, or raise the edge cap for the test source.

## 2. How the auth works (why a load test can mint its own tokens)

The API verifies a **self-minted EdDSA JWT** (`iss=argus`, `aud=argus-api`, 10-min TTL) with the key from
`SESSION_SIGNING_KEY_FILE`, and derives the tenant from a `user_tenant_index` row keyed by the token `sub`
([auth.service.ts](../../apps/api/src/auth/auth.service.ts)). It does **not** call out to any OIDC provider and
does **not** check `auth_sessions` at verify time. So if the load test **shares the API's signing key file**, it
can mint valid tokens offline — no browser, no passkey ceremony.

Because the server is **crypto-blind**, the seed can also create conversations + memberships **directly in the
DB** with synthetic data: the gateway's `subscribe` only checks `conversation_members`, and a stored message is
opaque ciphertext metadata. No MLS group state is needed server-side to exercise the real connect → auth →
subscribe path.

## 3. Seed: a dedicated load-test tenant + N tokens

**Local / dedicated-load-test environments only** — the script refuses `NODE_ENV=production` and any
non-loopback DB host (mirrors [seed.dev.ts](../../apps/api/src/db/seed.dev.ts)). Save it **inside the
`@argus/api` workspace** as **`apps/api/seed-loadtest.ts`** so its `postgres` / `jose` imports resolve, and run
it with that workspace's `tsx` (below):

```ts
// seed-loadtest.ts — provision a DEDICATED load-test tenant: N users, pairwise 1:1 conversations,
// and N bearer tokens for k6. Operator-run, LOCAL/dedicated-env ONLY. Tokens → ./loadtest-tokens.json
// (gitignored). DELETE that file after the run; it is never logged.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { SignJWT, importPKCS8 } from 'jose';

const N = Number(process.argv[2] ?? 100); // number of users (and ~N tokens; paired into N/2 conversations)
const TENANT = '00000000-0000-4000-a000-0000000000ff'; // synthetic, unmistakable: the LOAD-TEST tenant

// Guards (mirror seed.dev.ts): never a real database.
if (process.env.NODE_ENV === 'production') { console.error('refusing: NODE_ENV=production'); process.exit(1); }
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL; // owner conn (as seed.dev.ts)
const keyFile = process.env.SESSION_SIGNING_KEY_FILE; // the SAME key the API loads — so tokens verify
if (!url) { console.error('set DATABASE_URL (owner connection)'); process.exit(1); }
if (!keyFile) { console.error('set SESSION_SIGNING_KEY_FILE (same key the API loads)'); process.exit(1); }
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
let host: string;
try { host = new URL(url).hostname; } catch { console.error('DATABASE_URL not a URL'); process.exit(1); }
if (!LOOPBACK.has(host)) { console.error(`refusing non-local DB host: ${host}`); process.exit(1); }

// Load the same Ed25519 key the API loads (mirrors loadSessionKeys() in auth/session-key.config.ts).
const signingKey = await importPKCS8((await readFile(keyFile, 'utf8')).trim(), 'EdDSA');
// Mint mirrors SessionTokenService.mintAccessToken (auth/session-token.service.ts).
const mint = (sub: string, uid: string) =>
  new SignJWT({ sub, sid: randomUUID(), uid })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'argus-session-v1' })
    .setIssuer('argus').setAudience('argus-api')
    .setIssuedAt().setExpirationTime('10m').sign(signingKey);

const sql = postgres(url, { max: 1, onnotice: () => {} });
const users = Array.from({ length: N }, (_, i) => ({ id: randomUUID(), sub: `argusid:loadtest-${i}` }));
try {
  // Idempotent: clear any prior run's rows for THIS synthetic tenant first (FK-safe order), so re-running
  // never accumulates duplicate conversations/members.
  await sql`delete from conversation_members where tenant_id = ${TENANT}`;
  await sql`delete from messages where tenant_id = ${TENANT}`;
  await sql`delete from conversations where tenant_id = ${TENANT}`;
  await sql`delete from users where tenant_id = ${TENANT}`;
  await sql`delete from user_tenant_index where tenant_id = ${TENANT}`;
  await sql`insert into tenants (id, name) values (${TENANT}, 'Load Test Tenant') on conflict (id) do nothing`;
  for (const u of users) {
    await sql`insert into users (id, tenant_id, external_identity_id, argus_id, display_name, status, role)
              values (${u.id}, ${TENANT}, ${u.sub}, ${u.sub}, 'loadtest', 'active', 'member')
              on conflict (id) do nothing`;
    await sql`insert into user_tenant_index (sub, tenant_id) values (${u.sub}, ${TENANT})
              on conflict (sub) do nothing`;
  }
  // Pair users into 1:1 conversations so each token has a real, member-gated conversation to read/subscribe.
  const out: { sub: string; uid: string; token: string; conversationId: string }[] = [];
  for (let i = 0; i + 1 < N; i += 2) {
    const conv = randomUUID();
    await sql`insert into conversations (id, tenant_id, created_by, is_direct)
              values (${conv}, ${TENANT}, ${users[i].id}, true) on conflict (id) do nothing`;
    for (const u of [users[i], users[i + 1]]) {
      await sql`insert into conversation_members (id, tenant_id, conversation_id, user_id)
                values (${randomUUID()}, ${TENANT}, ${conv}, ${u.id})`;
      out.push({ sub: u.sub, uid: u.id, token: await mint(u.sub, u.id), conversationId: conv });
    }
  }
  await writeFile('loadtest-tokens.json', JSON.stringify(out));
  console.log(`seeded ${TENANT}: ${users.length} users, ${out.length} tokens -> loadtest-tokens.json`);
} finally {
  await sql.end();
}
```

Run it:

```bash
make up && make migrate                                   # stack + schema (idempotent), from the repo root

# The key + seed live in apps/api so the workspace deps resolve; run them from there:
cd apps/api
openssl genpkey -algorithm Ed25519 -out loadtest-signing.pem   # throwaway signing key (PKCS8 PEM); regenerate each run

SESSION_SIGNING_KEY_FILE="$PWD/loadtest-signing.pem" \
DATABASE_URL="postgres://argus:argus_local_dev@localhost:5432/argus" \
  pnpm exec tsx seed-loadtest.ts 200                      # -> apps/api/loadtest-tokens.json (200 users, 200 tokens)

# In a SECOND terminal, from the repo ROOT, start the API with the SAME key so the minted tokens verify:
#   SESSION_SIGNING_KEY_FILE="$PWD/apps/api/loadtest-signing.pem" make api-dev
```

## 4. The k6 script

Save as **`apps/api/messaging-load.js`** (next to the seed, so k6 and the tokens file share a directory). Two
scenarios run concurrently: **authed REST reads** and **authed WS connect→subscribe** (the concurrency
ceiling). Tune `BASE_URL` / `WS_URL` for the target.

```js
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
// Local default is plain ws (TLS terminates at the Cloudflare edge in prod); set WS_SCHEME=wss for a TLS endpoint.
const WS_URL = __ENV.WS_URL || `${__ENV.WS_SCHEME || 'ws'}://localhost:3000/ws`;
const TARGET = Number(__ENV.TARGET || 200);
const tokens = JSON.parse(open('./loadtest-tokens.json'));   // produced by seed-loadtest.ts
const wsOk = new Rate('ws_connect_ok');

export const options = {
  scenarios: {
    rest: {
      executor: 'ramping-vus', exec: 'rest', startVUs: 0,
      stages: [{ duration: '30s', target: Math.ceil(TARGET / 4) }, { duration: '1m', target: Math.ceil(TARGET / 4) }, { duration: '30s', target: 0 }],
    },
    realtime: {
      executor: 'ramping-vus', exec: 'realtime', startVUs: 0,
      stages: [{ duration: '30s', target: TARGET }, { duration: '1m', target: TARGET }, { duration: '30s', target: 0 }],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'], // SLO: p95 < 1s
    http_req_failed: ['rate<0.01'],    // SLO: errors < 1%
    ws_connect_ok: ['rate>0.99'],      // SLO: connect+auth success > 99%
  },
};

function pick() { return tokens[(__VU * 7 + __ITER) % tokens.length]; }

// Authed, member-gated read: exercises the JWT guard + RLS-scoped DB query.
export function rest() {
  const t = pick();
  const r = http.get(`${BASE}/conversations/${t.conversationId}/messages?limit=50`, {
    headers: { Authorization: `Bearer ${t.token}` },
  });
  check(r, { 'messages 200': (x) => x.status === 200 });
  sleep(1); // pace under the 120 req/min/user global limit
}

// Connect, authenticate (first frame), subscribe to the member conversation, hold briefly.
export function realtime() {
  const t = pick();
  let authed = false;
  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => socket.send(JSON.stringify({ event: 'auth', data: { token: t.token } })));
    socket.on('message', (raw) => {
      const f = JSON.parse(raw);
      if (f.event === 'ready') {
        authed = true;
        socket.send(JSON.stringify({ event: 'subscribe', data: { conversationId: t.conversationId } }));
      }
    });
    socket.setTimeout(() => socket.close(), 5000); // hold the connection ~5s, then close
  });
  // ws.connect blocks until the socket closes. Record success AND failure so the >0.99 threshold is meaningful —
  // recording only successes would peg the rate at 100% and hide every failed connect/auth.
  wsOk.add(authed);
  check(res, { 'ws handshake 101': (r) => r && r.status === 101 });
}
```

Run it via the k6 Docker image (no install):

```bash
# Run from apps/api (where the seed wrote loadtest-tokens.json next to messaging-load.js).
# Linux (host networking reaches localhost):
docker run --rm --network host -v "$PWD:/work" -w /work \
  -e BASE_URL=http://localhost:3000 -e WS_URL=ws://localhost:3000/ws -e TARGET=200 \
  grafana/k6 run messaging-load.js

# macOS / Windows (no host networking — reach the host via host.docker.internal):
docker run --rm -v "$PWD:/work" -w /work \
  -e BASE_URL=http://host.docker.internal:3000 -e WS_URL=ws://host.docker.internal:3000/ws -e TARGET=200 \
  grafana/k6 run messaging-load.js
```

k6 prints `http_req_duration` percentiles, `http_req_failed`, and `ws_connect_ok`; a threshold breach exits
non-zero. Re-run while **raising `TARGET`** until p95 crosses 1 s — that crossing is the box's concurrency knee.

### Optional extension — message-relay throughput

The scenarios above measure the capacity ceiling (open authenticated sockets + auth/DB throughput). To also
measure **fan-out**, add a scenario that `POST`s synthetic ciphertext to `/conversations/:id/messages` (body per
the `SendMessage` schema in `@argus/contracts`: `clientMessageId`, base64 `ciphertext`, `alg`, `epoch`) while a
peer VU is subscribed, and assert the `message` frame arrives. Synthetic bytes are fine — the server is
crypto-blind. This is the natural addition for the at-scale run at arming.

## 5. Safety

- **Dedicated load-test tenant only** (`…00ff`). Never run the seed or the test against a tenant with real user
  data. The seed's loopback + `NODE_ENV` guards make a stray prod DSN refuse.
- **Tokens are bearer credentials.** `apps/api/loadtest-tokens.json` and `apps/api/loadtest-signing.pem` are
  short-lived scratch files — keep them out of git (see [§7](#7-gitignore)) and **delete them after the run**
  (also remove `apps/api/seed-loadtest.ts` and `apps/api/messaging-load.js`). They are never logged.
- **Re-running is idempotent:** the seed clears the load-test tenant's rows before re-seeding, so synthetic
  data never accumulates. (`make reset` wipes the whole local DB if you want a fully clean slate.) Tokens
  expire in 10 minutes regardless; re-seed for a fresh run.
- The **at-scale run is gated on arming** — locally this is a low-VU smoke check that the harness works.

## 6. Results log

| Date (UTC) | Env | TARGET | p95 (ms) | error % | WS ok % | Knee (VUs) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _pending arming_ | | | | | | | first at-scale run at go-live |

## 7. .gitignore

The scratch artifacts live under `apps/api/`; the repo ignores them (added with this checkpoint). These bare
patterns match the files at any depth, and the signing key is already covered by the existing `*.pem` rule:

```
loadtest-tokens.json   # bearer tokens (matches apps/api/loadtest-tokens.json)
seed-loadtest.ts       # the operator's copy of the seed
messaging-load.js      # the operator's copy of the k6 script
# loadtest-signing.pem is already covered by *.pem
```
