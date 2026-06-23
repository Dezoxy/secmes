import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Shield, CheckCircle, Server, Lock } from 'lucide-react';
import { ArgusAppIcon } from '../features/brand/ArgusAppIcon';

interface BundleManifest {
  algorithm: string;
  bundleDigest: string;
  files: Array<{ file: string; sha384: string; bytes: number }>;
}

type ManifestState =
  | { status: 'loading' }
  | { status: 'ok'; manifest: BundleManifest }
  | { status: 'error' };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TransparencyRoute() {
  const navigate = useNavigate();
  const [manifestState, setManifestState] = useState<ManifestState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/bundle-manifest.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<unknown>;
      })
      .then((raw) => {
        const manifest = raw as BundleManifest;
        if (typeof manifest?.bundleDigest !== 'string' || !Array.isArray(manifest?.files)) {
          throw new Error('unexpected shape');
        }
        if (!cancelled) setManifestState({ status: 'ok', manifest });
      })
      .catch(() => {
        if (!cancelled) setManifestState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalBytes =
    manifestState.status === 'ok'
      ? manifestState.manifest.files.reduce((sum, f) => sum + f.bytes, 0)
      : 0;

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/');
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f16] text-white">
      {/* Sticky navigation */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0f0f16]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5 sm:px-8">
          <Link
            to="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
            aria-label="Argus home"
          >
            <ArgusAppIcon className="h-8 w-8 rounded-xl shadow-lg shadow-purple-500/20" />
            <span className="text-sm font-bold tracking-[0.12em] text-purple-400">ARGUS</span>
          </Link>
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-medium text-white/70 transition-all hover:border-purple-500/30 hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Sign In
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-white/5 py-14 sm:py-20">
        <div className="mx-auto max-w-3xl px-5 text-center sm:px-8">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-purple-400/20 bg-purple-400/5 px-3.5 py-1.5 text-xs font-semibold tracking-wide text-purple-300">
            <Shield className="h-3.5 w-3.5" />
            Privacy First
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Security &amp; Transparency
          </h1>
          <p className="mx-auto max-w-xl text-lg leading-relaxed text-white/55">
            How Argus protects your messages, how you can verify the code running in your browser,
            and who processes your data.
          </p>
        </div>
      </section>

      {/* Quick-facts strip */}
      <section className="border-b border-white/5 bg-white/[0.02]">
        <div className="mx-auto grid max-w-5xl grid-cols-1 divide-y divide-white/5 px-5 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-8">
          {[
            {
              icon: Lock,
              title: 'End-to-end encrypted',
              body: 'MLS RFC 9420 with forward secrecy',
            },
            { icon: Server, title: 'EU data residency', body: 'All data stored in Germany West Central' },
            {
              icon: CheckCircle,
              title: 'Verifiable builds',
              body: 'SHA-384 bundle digest published each deploy',
            },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex items-start gap-3.5 px-0 py-6 sm:px-8">
              <div className="mt-0.5 shrink-0 rounded-lg border border-purple-400/20 bg-purple-400/5 p-2">
                <Icon className="h-4 w-4 text-purple-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-white/50">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Main content */}
      <main className="mx-auto max-w-5xl px-5 py-14 sm:px-8 sm:py-20">
        <div className="space-y-14">
          {/* Section 1 — Security model */}
          <section aria-labelledby="security-model-heading">
            <div className="mb-6 flex items-center gap-2.5">
              <Shield className="h-5 w-5 text-purple-400" />
              <h2 id="security-model-heading" className="text-xl font-bold text-white">
                End-to-end encryption
              </h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
                <p className="mb-2 text-sm font-semibold text-white">The server is crypto-blind</p>
                <p className="text-sm leading-relaxed text-white/60">
                  Argus stores and forwards ciphertext only. The server never holds decryption keys
                  and cannot read message content or attachment data.
                </p>
              </div>
              <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
                <p className="mb-2 text-sm font-semibold text-white">Protocol: MLS (RFC 9420)</p>
                <p className="text-sm leading-relaxed text-white/60">
                  Messages use the{' '}
                  <a
                    href="https://www.rfc-editor.org/rfc/rfc9420"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-purple-400 underline underline-offset-2 hover:text-purple-300"
                  >
                    Messaging Layer Security standard
                    <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  via{' '}
                  <code className="rounded bg-white/10 px-1 py-0.5 text-xs">ts-mls</code>. Ciphersuite:{' '}
                  <code className="rounded bg-white/10 px-1 py-0.5 text-xs">
                    MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
                  </code>
                  . Each message advances the ratchet, providing forward secrecy.
                </p>
              </div>
              <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
                <p className="mb-2 text-sm font-semibold text-white">Passkey-only authentication</p>
                <p className="text-sm leading-relaxed text-white/60">
                  Sign-in uses WebAuthn passkeys with a PRF extension to derive a local keystore
                  unlock key. No passwords are stored, and the server never sees your private key
                  material.
                </p>
              </div>
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-6">
                <p className="mb-2 text-sm font-semibold text-amber-300">PWA code-delivery caveat</p>
                <p className="text-sm leading-relaxed text-white/55">
                  Argus is a web app — encryption code is delivered by the server on each load. A
                  fully compromised server could ship malicious JavaScript. Mitigations include a
                  strict Content-Security-Policy, SRI hashes on entry scripts, service-worker
                  pinning, and reproducible builds with a published bundle digest. This is the
                  accepted trade-off for browser delivery: strong privacy, not unconditional
                  security.
                </p>
              </div>
            </div>
          </section>

          {/* Section 2 — Bundle integrity */}
          <section aria-labelledby="bundle-integrity-heading">
            <div className="mb-6 flex items-center gap-2.5">
              <CheckCircle className="h-5 w-5 text-purple-400" />
              <h2 id="bundle-integrity-heading" className="text-xl font-bold text-white">
                Bundle integrity
              </h2>
            </div>
            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
              <p className="mb-5 text-sm leading-relaxed text-white/60">
                Every build publishes a{' '}
                <code className="rounded bg-white/10 px-1 py-0.5 text-xs">/bundle-manifest.json</code>{' '}
                file containing SHA-384 hashes of every JavaScript and CSS asset, plus a single
                deterministic <span className="font-medium text-white">bundle digest</span> over all
                of them. The value below is served fresh with each page load.
              </p>

              {manifestState.status === 'loading' && (
                <div className="rounded-xl border border-white/5 bg-white/[0.025] px-4 py-3 text-xs text-white/40">
                  Loading bundle digest…
                </div>
              )}

              {manifestState.status === 'error' && (
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs text-amber-300">
                  Bundle manifest unavailable in this environment.
                </div>
              )}

              {manifestState.status === 'ok' && (
                <div className="space-y-3">
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-white/50">
                      Bundle digest (SHA-384, base64)
                    </p>
                    <code
                      className="block break-all rounded-xl border border-purple-400/20 bg-[#12121a] px-4 py-3 font-mono text-xs leading-relaxed text-purple-300"
                      data-testid="bundle-digest"
                    >
                      {manifestState.manifest.bundleDigest}
                    </code>
                  </div>
                  <p className="text-xs text-white/50">
                    {manifestState.manifest.files.length} assets · {formatBytes(totalBytes)} total ·
                    algorithm: {manifestState.manifest.algorithm}
                  </p>
                </div>
              )}

              <div className="mt-5 border-t border-white/5 pt-5 text-sm leading-relaxed text-white/55">
                <p className="font-medium text-white/70">How to verify independently</p>
                <p className="mt-1.5">
                  Download{' '}
                  <code className="rounded bg-white/10 px-1 py-0.5 text-xs">/bundle-manifest.json</code>
                  , fetch each listed asset, compute its{' '}
                  <code className="rounded bg-white/10 px-1 py-0.5 text-xs">sha384sum</code>, and
                  compare against the manifest. The{' '}
                  <code className="rounded bg-white/10 px-1 py-0.5 text-xs">bundleDigest</code> is the
                  SHA-384 over the sorted &ldquo;file sha384&rdquo; lines — a single fingerprint for
                  the entire build.
                </p>
              </div>
            </div>
          </section>

          {/* Section 3 — Sub-processors & data residency */}
          <section aria-labelledby="sub-processors-heading">
            <div className="mb-6 flex items-center gap-2.5">
              <Server className="h-5 w-5 text-purple-400" />
              <h2 id="sub-processors-heading" className="text-xl font-bold text-white">
                Sub-processors &amp; data residency
              </h2>
            </div>
            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-6">
              <p className="mb-6 text-sm leading-relaxed text-white/60">
                All data at rest is stored and processed exclusively in the EU/EEA. Cloudflare
                terminates TLS at global edge PoPs for ingress and WAF — data in transit only,
                nothing stored — so TLS handshakes occur outside the EU. No personal data is stored
                or processed by any sub-processor outside the EU/EEA.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="pb-3 pr-6 text-xs font-semibold uppercase tracking-wider text-white/40">
                        Processor
                      </th>
                      <th className="pb-3 pr-6 text-xs font-semibold uppercase tracking-wider text-white/40">
                        Role
                      </th>
                      <th className="pb-3 text-xs font-semibold uppercase tracking-wider text-white/40">
                        Region
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-white/65">
                    <tr>
                      <td className="py-3.5 pr-6 font-medium text-white">Microsoft Azure</td>
                      <td className="py-3.5 pr-6">VM compute, Key Vault, networking</td>
                      <td className="py-3.5 text-sm text-white/50">EU — Germany West Central</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 pr-6 font-medium text-white">Backblaze B2</td>
                      <td className="py-3.5 pr-6">
                        Encrypted attachment blobs &amp; DB backups (ciphertext only)
                      </td>
                      <td className="py-3.5 text-sm text-white/50">EU — eu-central-003</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 pr-6 font-medium text-white">Cloudflare</td>
                      <td className="py-3.5 pr-6">
                        Ingress, TLS termination, WAF (data in transit only — nothing stored)
                      </td>
                      <td className="py-3.5 text-sm text-white/50">Global edge</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-5 text-xs leading-relaxed text-white/40">
                GlitchTip (error tracking) is self-hosted on the same Azure VM — it is not a
                separate sub-processor and involves no third-party data transfer.
              </p>

              <div className="mt-5 border-t border-white/5 pt-5 text-sm leading-relaxed text-white/60">
                <span className="font-semibold text-white">Your GDPR rights.</span> You can export
                all metadata Argus holds about you (Art. 20 portability) or permanently delete your
                account (Art. 17 erasure) at any time from{' '}
                <Link
                  to="/settings"
                  className="text-purple-400 underline underline-offset-2 hover:text-purple-300"
                >
                  Settings
                </Link>
                .
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-5 text-center sm:px-8">
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-1.5 text-sm text-white/40 transition-colors hover:text-white/70"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Sign In
          </button>
          <p className="text-xs text-white/25">&copy; {new Date().getFullYear()} Argus</p>
        </div>
      </footer>
    </div>
  );
}
