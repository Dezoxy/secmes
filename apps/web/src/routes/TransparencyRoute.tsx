import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Shield } from 'lucide-react';
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

  return (
    <main
      aria-label="Security and transparency"
      className="min-h-screen bg-[#1a1a24] px-4 py-10 text-white"
    >
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <header className="mb-10">
          <Link
            to="/"
            className="mb-6 inline-flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Argus
          </Link>
          <div className="flex items-center gap-3">
            <ArgusAppIcon className="h-10 w-10 rounded-xl shadow-lg shadow-purple-500/20" />
            <div>
              <p className="text-xs font-semibold tracking-[0.12em] text-purple-400">ARGUS</p>
              <h1 className="text-xl font-bold tracking-tight text-white">
                Security &amp; Transparency
              </h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-white/60">
            This page explains how Argus protects your messages, how you can independently verify
            the code running in your browser, and which infrastructure providers process your data.
          </p>
        </header>

        {/* Section 1 — Security model */}
        <section aria-labelledby="security-model-heading" className="mb-8">
          <div className="mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4 text-purple-400" />
            <h2 id="security-model-heading" className="text-base font-semibold text-white">
              End-to-end encryption
            </h2>
          </div>
          <div className="space-y-4 rounded-xl border border-white/5 bg-white/[0.03] px-5 py-4 text-sm leading-relaxed text-white/70">
            <p>
              <span className="font-medium text-white">The server is crypto-blind.</span> Argus
              stores and forwards ciphertext — it never holds decryption keys and cannot read
              message content, attachment data, or key backups.
            </p>
            <p>
              <span className="font-medium text-white">Protocol: MLS (RFC 9420).</span> Messages are
              encrypted using the{' '}
              <a
                href="https://www.rfc-editor.org/rfc/rfc9420"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-purple-400 underline underline-offset-2 hover:text-purple-300"
              >
                Messaging Layer Security standard
                <ExternalLink className="h-3 w-3" />
              </a>{' '}
              via the <code className="rounded bg-white/10 px-1 py-0.5 text-xs">ts-mls</code>{' '}
              library. The pinned ciphersuite is{' '}
              <code className="rounded bg-white/10 px-1 py-0.5 text-xs">
                MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
              </code>
              . Each message advances the ratchet, providing{' '}
              <span className="font-medium text-white">forward secrecy</span> — a compromised key
              cannot decrypt past messages.
            </p>
            <p>
              <span className="font-medium text-white">Key backup.</span> Your private key material
              is sealed with AES-256-GCM under a key derived from your passphrase via Argon2id
              (memory-hard KDF). Only the resulting ciphertext is stored server-side — the server
              cannot recover your keys without your passphrase.
            </p>
            <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3">
              <p className="font-medium text-amber-300">PWA code-delivery caveat</p>
              <p className="mt-1 text-white/60">
                Argus is a web app: the encryption code is delivered by the server on each load. A
                fully compromised server could ship malicious JavaScript to intercept plaintext
                before encryption. Mitigations: a strict Content-Security-Policy, Subresource
                Integrity (SRI) hashes on every script and stylesheet, service-worker pinning, and
                reproducible builds with a published bundle digest (see below). This is the accepted
                trade-off for a browser-delivered app — strong privacy, not unconditional security.
              </p>
            </div>
          </div>
        </section>

        {/* Section 2 — Bundle integrity */}
        <section aria-labelledby="bundle-integrity-heading" className="mb-8">
          <h2 id="bundle-integrity-heading" className="mb-4 text-base font-semibold text-white">
            Bundle integrity
          </h2>
          <div className="rounded-xl border border-white/5 bg-white/[0.03] px-5 py-4 text-sm">
            <p className="mb-3 leading-relaxed text-white/70">
              Every build publishes a{' '}
              <code className="rounded bg-white/10 px-1 py-0.5 text-xs">/bundle-manifest.json</code>{' '}
              file containing SHA-384 hashes of every JavaScript and CSS asset, plus a single
              deterministic <span className="font-medium text-white">bundle digest</span> over all
              of them. The value below is served fresh with each page load.
            </p>

            {manifestState.status === 'loading' && (
              <div className="rounded-lg border border-white/5 bg-white/[0.025] px-4 py-3 text-xs text-white/40">
                Loading bundle digest…
              </div>
            )}

            {manifestState.status === 'error' && (
              <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs text-amber-300">
                Bundle manifest unavailable in this environment.
              </div>
            )}

            {manifestState.status === 'ok' && (
              <div className="space-y-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-white/50">
                    Bundle digest (SHA-384, base64)
                  </p>
                  <code
                    className="block break-all rounded-lg border border-purple-400/20 bg-[#12121a] px-4 py-3 font-mono text-xs leading-relaxed text-purple-300"
                    data-testid="bundle-digest"
                  >
                    {manifestState.manifest.bundleDigest}
                  </code>
                </div>
                <p className="text-xs text-white/50">
                  {manifestState.manifest.files.length} assets · {formatBytes(totalBytes)} total ·{' '}
                  algorithm: {manifestState.manifest.algorithm}
                </p>
              </div>
            )}

            <p className="mt-4 leading-relaxed text-white/60">
              To verify independently: download{' '}
              <code className="rounded bg-white/10 px-1 py-0.5 text-xs">/bundle-manifest.json</code>
              , fetch each listed asset, compute its{' '}
              <code className="rounded bg-white/10 px-1 py-0.5 text-xs">sha384sum</code>, and
              compare against the manifest. The{' '}
              <code className="rounded bg-white/10 px-1 py-0.5 text-xs">bundleDigest</code> is the
              SHA-384 over the sorted &ldquo;file sha384&rdquo; lines — a single fingerprint for the
              entire build.
            </p>
          </div>
        </section>

        {/* Section 3 — Sub-processors & data residency */}
        <section aria-labelledby="sub-processors-heading" className="mb-8">
          <h2 id="sub-processors-heading" className="mb-4 text-base font-semibold text-white">
            Sub-processors &amp; data residency
          </h2>
          <div className="rounded-xl border border-white/5 bg-white/[0.03] px-5 py-4 text-sm">
            <p className="mb-4 leading-relaxed text-white/70">
              All personal data is processed exclusively in the EU/EEA. No data is transferred to
              third countries.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="pb-2 pr-4 font-semibold text-white/50">Processor</th>
                    <th className="pb-2 pr-4 font-semibold text-white/50">Role</th>
                    <th className="pb-2 font-semibold text-white/50">Region</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-white/70">
                  <tr>
                    <td className="py-2.5 pr-4 font-medium text-white">Microsoft Azure</td>
                    <td className="py-2.5 pr-4">VM compute, Key Vault, networking</td>
                    <td className="py-2.5">EU — Germany West Central</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4 font-medium text-white">Backblaze B2</td>
                    <td className="py-2.5 pr-4">
                      Encrypted attachment blobs &amp; DB backups (ciphertext only)
                    </td>
                    <td className="py-2.5">EU — eu-central-003</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4 font-medium text-white">Cloudflare</td>
                    <td className="py-2.5 pr-4">
                      Ingress, TLS termination, WAF (data in transit only — nothing stored)
                    </td>
                    <td className="py-2.5">Global edge</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-white/50">
              Zitadel (identity provider) and GlitchTip (error tracking) are self-hosted on the same
              Azure VM — they are not separate sub-processors and involve no third-party data
              transfer.
            </p>

            <div className="mt-4 border-t border-white/5 pt-4 text-xs leading-relaxed text-white/60">
              <span className="font-medium text-white">Your GDPR rights.</span> You can export all
              metadata Argus holds about you (Art. 20 portability) or permanently delete your
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

        {/* Footer */}
        <footer className="mt-10 text-center text-xs text-white/30">
          <Link to="/" className="transition-colors hover:text-white/60">
            ← Back to Argus
          </Link>
        </footer>
      </div>
    </main>
  );
}
