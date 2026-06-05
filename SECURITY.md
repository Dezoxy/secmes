# Security Policy

secmes is a privacy-first, end-to-end-encrypted messaging platform — security and
user privacy are the entire point of the project. We take vulnerability reports
seriously and welcome responsible disclosure.

## Supported versions

The project is in active pre-release development; there are no stable releases yet.
Security fixes land on the `main` branch.

| Version              | Supported |
| -------------------- | --------- |
| `main` (pre-release) | ✅        |

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for security
reports.**

Preferred channel — **GitHub private vulnerability reporting**:
Repository **Security** tab → **Report a vulnerability** (GitHub Security
Advisories). This opens a private thread visible only to the maintainers.

If you cannot use GitHub, email **security@secmes.example** _(replace with your real
ops/security alias before relying on this)_.

Please include:

- A clear description and the affected component (crypto/keys, server/API, tenant
  isolation, auth, or infra/CI).
- Steps to reproduce or a proof of concept.
- Impact assessment and any suggested remediation.

## Scope — what matters most

Given the threat model, these classes are highest priority:

- Any way the **server could read plaintext** content or obtain private / session /
  message keys (the platform is designed to be crypto-blind).
- **Cross-tenant** data access or Row-Level-Security bypass.
- **Key handling** flaws: weak randomness, key leakage, broken backup/recovery,
  or misuse of the MLS protocol layer.
- **Authentication / authorization** bypass (IDOR, token handling).
- Secrets exposure, SSRF, RCE, injection, or supply-chain compromise.
- Infrastructure exposure: public data services, privilege escalation, leaked
  credentials.

## Out of scope

- Volumetric DoS or brute force without a concrete underlying vulnerability.
- Social engineering, physical attacks, or already-compromised end-user devices.
- Findings only reproducible on heavily outdated browsers.
- Automated-scanner output without a demonstrated, exploitable impact.
- Vulnerabilities in third-party dependencies already tracked upstream (report
  those to the upstream project; we consume fixes via Dependabot).

## Our commitment

- We aim to **acknowledge** a report within **3 business days** and give a status
  update within **10 business days**.
- We practice **coordinated disclosure**: we'll agree a fix and timeline with you
  before any public disclosure, and credit you (if you wish) once it's resolved.

## Safe harbor

We will not pursue or support legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service disruption;
- Only interact with accounts they own or have explicit permission to test;
- Report promptly and allow reasonable time to remediate before disclosure.

Thank you for helping keep secmes and its users safe.
